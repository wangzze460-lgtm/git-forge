// The forge's HTTP surface: one process, no UI.
//   GET  /healthz                                   boot probe (200 {"ok":true})
//   GET  /{owner}/{repo}.git/info/refs?service=...  git advertisement (v2 or v0)
//   POST /{owner}/{repo}.git/git-upload-pack         upload-pack v2 / v0
//   POST /{owner}/{repo}.git/git-receive-pack        receive-pack v0
//   *    /api/v3/...                                 REST v3
//   POST /api/graphql                                GraphQL v4
//   POST /mcp                                        MCP (Streamable HTTP)

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

const jsonType = "application/json; charset=utf-8"
const maxBodyBytes = 64 * 1024 * 1024

// httpRequest is one fully-read request, transport-independent.
type httpRequest struct {
	Method  string
	Path    string
	Query   map[string]string
	Headers map[string]string
	Body    []byte
	Host    string
}

func (r *httpRequest) queryGet(key string) string {
	if r.Query == nil {
		return ""
	}
	return r.Query[key]
}

// httpResponse is one reply, transport-independent.
type httpResponse struct {
	Status  int
	Headers map[string]string
	Body    []byte
}

// marshalJSON renders v as JSON the way JSON.stringify does: no HTML escaping
// (Go escapes <, > and & by default; JSON.stringify does not), no trailing
// newline, struct fields in declaration order.
func marshalJSON(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	b := buf.Bytes()
	if len(b) > 0 && b[len(b)-1] == '\n' {
		b = b[:len(b)-1]
	}
	return b
}

var appRequestCounter int64

func nextAppRequestID() string {
	appRequestCounter++
	return "req-app-" + itoa(int(appRequestCounter))
}

func send(status int, contentType string, body []byte, extra ...map[string]string) *httpResponse {
	headers := map[string]string{
		"content-type":       contentType,
		"content-length":     itoa(len(body)),
		"x-github-request-id": nextAppRequestID(),
	}
	for _, m := range extra {
		for k, v := range m {
			headers[k] = v
		}
	}
	return &httpResponse{Status: status, Headers: headers, Body: body}
}

func sendJSON(status int, body any, extra ...map[string]string) *httpResponse {
	var text []byte
	if s, ok := body.(string); ok {
		text = []byte(s)
	} else {
		text = marshalJSON(body)
	}
	// The Node sendJson appends a trailing newline.
	text = append(text, '\n')
	return send(status, jsonType, text, extra...)
}

func sendRawJSON(status int, body []byte, extraHeaders map[string]string) *httpResponse {
	return send(status, jsonType, body, extraHeaders)
}

// server holds the shared state and the three API routers.
type server struct {
	store       *Store
	viewerToken string
	rest        *restRouter
	graphql     *graphqlRouter
	mcp         *mcpRouter
}

func newServer() *server {
	store := NewStore()
	viewerToken := os.Getenv("MAKEFUN_SHOP_TOKEN")
	return &server{
		store:       store,
		viewerToken: viewerToken,
		rest:        newRestRouter(store, viewerToken),
		graphql:     newGraphqlRouter(store),
		mcp:         newMcpRouter(store),
	}
}

func gitRepoPath(path string) (owner, repo, suffix string, ok bool) {
	// /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
	if !strings.HasPrefix(path, "/") {
		return "", "", "", false
	}
	rest := path[1:]
	// owner
	i := strings.IndexByte(rest, '/')
	if i < 0 {
		return "", "", "", false
	}
	owner = rest[:i]
	rest = rest[i+1:]
	// repo.git
	if !strings.HasSuffix(rest, ".git/") && !strings.Contains(rest, ".git/") {
		return "", "", "", false
	}
	j := strings.Index(rest, ".git/")
	if j < 0 {
		return "", "", "", false
	}
	repo = rest[:j]
	suffix = rest[j+5:]
	if suffix != "info/refs" && suffix != "git-upload-pack" && suffix != "git-receive-pack" {
		return "", "", "", false
	}
	owner = urlUnescape(owner)
	repo = urlUnescape(repo)
	return owner, repo, suffix, true
}

// dispatch routes one fully-read request to its reply. Transport-independent.
func (s *server) dispatch(req *httpRequest) (out *httpResponse) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "[panic] %s %s: %v\n", req.Method, req.Path, r)
			out = sendJSON(500, map[string]string{"message": "Internal error"})
		}
	}()
	method := req.Method
	path := req.Path
	body := req.Body
	// Boot probe.
	if method == "GET" && path == "/healthz" {
		return sendJSON(200, map[string]bool{"ok": true})
	}
	// API root (no auth).
	if method == "GET" && (path == "/api/v3" || path == "/api/v3/") {
		return sendJSON(200, map[string]string{
			"current_user_url": "/api/v3/user",
			"rate_limit_url":   "/api/v3/rate_limit",
		}, map[string]string{"x-oauth-scopes": "repo, read:org"})
	}
	// REST v3 is the hot path: route it before the git pattern so API requests
	// never pay for a pattern they cannot match.
	if strings.HasPrefix(path, "/api/v3/") {
		return s.rest.handle(req)
	}
	// Git smart HTTP.
	if owner, repoName, suffix, ok := gitRepoPath(path); ok {
		s.store.mu.RLock()
		repo := s.store.getRepo(owner, repoName)
		s.store.mu.RUnlock()
		if repo == nil {
			return sendJSON(404, map[string]string{"message": "Not Found"})
		}
		isV2 := req.Headers["git-protocol"] == "version=2"
		if method == "GET" && suffix == "info/refs" {
			service := req.queryGet("service")
			if service == "git-upload-pack" {
				s.store.mu.RLock()
				var adv []byte
				if isV2 {
					adv = advertiseUploadV2(repo)
				} else {
					adv = advertiseUploadV0(repo)
				}
				s.store.mu.RUnlock()
				return send(200, "application/x-git-upload-pack-advertisement", adv)
			}
			if service == "git-receive-pack" {
				s.store.mu.RLock()
				adv := advertiseReceiveV0(repo)
				s.store.mu.RUnlock()
				return send(200, "application/x-git-receive-pack-advertisement", adv)
			}
			return sendJSON(400, map[string]string{"message": "service is required"})
		}
		if method == "POST" && suffix == "git-upload-pack" {
			s.store.mu.Lock()
			defer s.store.mu.Unlock()
			if isV2 {
				first := string(body)
				if len(first) > 64 {
					first = first[:64]
				}
				if strings.Contains(first, "command=ls-refs") {
					return send(200, "application/x-git-upload-pack-result", handleLsRefs(repo, body))
				}
				return send(200, "application/x-git-upload-pack-result", handleFetchV2(repo, body))
			}
			return send(200, "application/x-git-upload-pack-result", handleFetchV0(repo, body))
		}
		if method == "POST" && suffix == "git-receive-pack" {
			s.store.mu.Lock()
			defer s.store.mu.Unlock()
			return send(200, "application/x-git-receive-pack-result", handleReceivePack(repo, body))
		}
		return sendJSON(404, map[string]string{"message": "Not Found"})
	}
	// GraphQL v4.
	if path == "/api/graphql" && method == "POST" {
		auth := strings.TrimSpace(req.Headers["authorization"])
		token := ""
		if strings.HasPrefix(auth, "Bearer ") {
			token = strings.TrimSpace(auth[len("Bearer "):])
		}
		if token == "" || (s.viewerToken != "" && token != s.viewerToken) || (s.viewerToken == "" && token != "test-token") {
			return sendJSON(401, map[string]string{"message": "Requires authentication"})
		}
		var parsed any
		if err := json.Unmarshal(body, &parsed); err != nil {
			return sendJSON(400, map[string]any{"errors": []any{map[string]string{"message": "Malformed JSON in request body"}}})
		}
		if arr, ok := parsed.([]any); ok {
			results := make([]any, 0, len(arr))
			for _, doc := range arr {
				if m, ok := doc.(map[string]any); ok {
					results = append(results, s.graphql.execute(m))
				}
			}
			return sendJSON(200, results)
		}
		if m, ok := parsed.(map[string]any); ok {
			return sendJSON(200, s.graphql.execute(m))
		}
		return sendJSON(400, map[string]any{"errors": []any{map[string]string{"message": "Request body must be a JSON object or array"}}})
	}
	// MCP.
	if path == "/mcp" {
		return s.mcp.handle(req)
	}
	return sendJSON(404, map[string]string{"message": "Not Found"})
}
