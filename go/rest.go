// GitHub REST v3 surface (/api/v3). Go stdlib only.
// Auth: Bearer MAKEFUN_SHOP_TOKEN is the viewer (adaiversen). No token -> 401.
// Any other token is a stranger: it owns nothing, so repo-scoped reads are 404
// (never 403). All timestamps are the fixed trial instant, never the wall clock.

package main

import (
	"encoding/base64"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

// httpRequest / httpResponse are defined in app.go.

// jsonResponse renders value as JSON (no trailing newline) with content-type.
func jsonResponse(status int, value any, extra ...map[string]string) *httpResponse {
	var body []byte
	if s, ok := value.(string); ok {
		body = []byte(s)
	} else {
		body = marshalJSON(value)
	}
	headers := map[string]string{"content-type": "application/json"}
	for _, m := range extra {
		for k, v := range m {
			headers[k] = v
		}
	}
	return &httpResponse{Status: status, Headers: headers, Body: body}
}

func errorResponse(status int, message string) *httpResponse {
	return jsonResponse(status, map[string]string{"message": message})
}

// decodeSegment decodes a URL segment, skipping the call when there is no '%'.
func decodeSegment(s string) string {
	if !strings.Contains(s, "%") {
		return s
	}
	if decoded, err := urlPathUnescape(s); err == nil {
		return decoded
	}
	return s
}

func urlPathUnescape(s string) (string, error) {
	// Like net/url PathUnescape but without importing net/url for one call.
	var sb strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '%' && i+2 < len(s) {
			hi := hexVal(s[i+1])
			lo := hexVal(s[i+2])
			if hi >= 0 && lo >= 0 {
				sb.WriteByte(byte(hi<<4 | lo))
				i += 2
				continue
			}
		}
		sb.WriteByte(c)
	}
	return sb.String(), nil
}

var restRequestCounter int64

func withRequestID(res *httpResponse) *httpResponse {
	restRequestCounter++
	if res.Headers == nil {
		res.Headers = make(map[string]string)
	}
	res.Headers["x-github-request-id"] = "req-" + itoa(int(restRequestCounter))
	return res
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

type identity struct {
	login    string
	id       int
	isViewer bool
}

func authenticate(req *httpRequest, viewerToken string) *identity {
	auth := strings.TrimSpace(req.Headers["authorization"])
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil
	}
	token := strings.TrimSpace(auth[len("Bearer "):])
	if token == "" {
		return nil
	}
	if viewerToken != "" && token == viewerToken {
		return &identity{login: viewerLogin, id: viewerID, isViewer: true}
	}
	if viewerToken == "" && token == "test-token" {
		return &identity{login: viewerLogin, id: viewerID, isViewer: true}
	}
	// Any other bearer token is some other user who owns nothing here.
	return &identity{login: "stranger", id: 999999, isViewer: false}
}

func parseJSONBody(req *httpRequest) (map[string]any, *httpResponse) {
	if len(req.Body) == 0 {
		return map[string]any{}, nil
	}
	var value any
	if err := json.Unmarshal(req.Body, &value); err != nil {
		return nil, errorResponse(400, "Malformed JSON in request body")
	}
	if m, ok := value.(map[string]any); ok {
		return m, nil
	}
	return map[string]any{}, nil
}

// ---------------------------------------------------------------------------
// Shapes (struct field order matches the Node JSON field order)
// ---------------------------------------------------------------------------

type ownerJSON struct {
	Login string `json:"login"`
	ID    int    `json:"id"`
	Type  string `json:"type"`
}

type repoJSON struct {
	ID              int       `json:"id"`
	Name            string    `json:"name"`
	FullName        string    `json:"full_name"`
	Owner           ownerJSON `json:"owner"`
	Private         bool      `json:"private"`
	Description     string    `json:"description"`
	DefaultBranch   string    `json:"default_branch"`
	CreatedAt       string    `json:"created_at"`
	UpdatedAt       string    `json:"updated_at"`
	PushedAt        string    `json:"pushed_at"`
	HTMLURL         string    `json:"html_url"`
	CloneURL        string    `json:"clone_url"`
	GitURL          string    `json:"git_url"`
	SSHURL          string    `json:"ssh_url"`
	Homepage        any       `json:"homepage"`
	Language        any       `json:"language"`
	ForksCount      int       `json:"forks_count"`
	StargazersCount int       `json:"stargazers_count"`
	WatchersCount   int       `json:"watchers_count"`
	OpenIssuesCount int       `json:"open_issues_count"`
	Size            int       `json:"size"`
	Archived        bool      `json:"archived"`
	Disabled        bool      `json:"disabled"`
	Visibility      string    `json:"visibility"`
}

func toRepoJSON(repo *Repo) repoJSON {
	ownerID := 999999
	if repo.Owner == viewerLogin {
		ownerID = viewerID
	}
	open := 0
	for _, i := range repo.Issues {
		if i.State == "open" {
			open++
		}
	}
	visibility := "public"
	if repo.IsPrivate {
		visibility = "private"
	}
	return repoJSON{
		ID:              repo.ID,
		Name:            repo.Name,
		FullName:        repo.Owner + "/" + repo.Name,
		Owner:           ownerJSON{Login: repo.Owner, ID: ownerID, Type: "User"},
		Private:         repo.IsPrivate,
		Description:     repo.Description,
		DefaultBranch:   repo.DefaultBranch,
		CreatedAt:       repo.CreatedAt,
		UpdatedAt:       repo.UpdatedAt,
		PushedAt:        repo.UpdatedAt,
		HTMLURL:         "https://example.invalid/" + repo.Owner + "/" + repo.Name,
		CloneURL:        "https://example.invalid/" + repo.Owner + "/" + repo.Name + ".git",
		GitURL:          "git://example.invalid/" + repo.Owner + "/" + repo.Name + ".git",
		SSHURL:          "git@example.invalid:" + repo.Owner + "/" + repo.Name + ".git",
		Homepage:        nil,
		Language:        nil,
		OpenIssuesCount: open,
		Visibility:      visibility,
	}
}

type labelJSON struct {
	Name        string `json:"name"`
	Color       string `json:"color"`
	Description string `json:"description"`
	Default     bool   `json:"default"`
}

func toLabelJSON(l *Label) labelJSON {
	return labelJSON{Name: l.Name, Color: l.Color, Description: l.Description, Default: false}
}

type issueUserJSON struct {
	Login string `json:"login"`
	ID    int    `json:"id"`
	Type  string `json:"type"`
}

type issueJSON struct {
	ID        int          `json:"id"`
	Number    int          `json:"number"`
	Title     string       `json:"title"`
	Body      string       `json:"body"`
	State     string       `json:"state"`
	Labels    []labelJSON  `json:"labels"`
	User      issueUserJSON `json:"user"`
	CreatedAt string       `json:"created_at"`
	UpdatedAt string       `json:"updated_at"`
	ClosedAt  *string      `json:"closed_at"`
	Comments  int          `json:"comments"`
	HTMLURL   string       `json:"html_url"`
}

func toIssueJSON(issue *Issue, repo *Repo) issueJSON {
	userID := 999999
	if issue.UserLogin == viewerLogin {
		userID = viewerID
	}
	labels := make([]labelJSON, 0, len(issue.Labels))
	for _, l := range issue.Labels {
		labels = append(labels, toLabelJSON(l))
	}
	return issueJSON{
		ID:        issue.ID,
		Number:    issue.Number,
		Title:     issue.Title,
		Body:      issue.Body,
		State:     issue.State,
		Labels:    labels,
		User:      issueUserJSON{Login: issue.UserLogin, ID: userID, Type: "User"},
		CreatedAt: issue.CreatedAt,
		UpdatedAt: issue.UpdatedAt,
		ClosedAt:  issue.ClosedAt,
		Comments:  len(issue.Comments),
		HTMLURL:   "https://example.invalid/" + repo.Owner + "/" + repo.Name + "/issues/" + itoa(issue.Number),
	}
}

func renderIssueJSON(issue *Issue, repo *Repo) string {
	return string(marshalJSON(toIssueJSON(issue, repo)))
}

type pullHeadJSON struct {
	Ref   string `json:"ref"`
	Sha   string `json:"sha"`
	Label string `json:"label"`
}

type pullJSON struct {
	ID            int          `json:"id"`
	Number        int          `json:"number"`
	Title         string       `json:"title"`
	Body          string       `json:"body"`
	State         string       `json:"state"`
	Head          pullHeadJSON `json:"head"`
	Base          pullHeadJSON `json:"base"`
	Merged        bool         `json:"merged"`
	Mergeable     bool         `json:"mergeable"`
	MergeCommitSha *string     `json:"merge_commit_sha"`
	MergedAt      *string      `json:"merged_at"`
	User          issueUserJSON `json:"user"`
	CreatedAt     string       `json:"created_at"`
	UpdatedAt     string       `json:"updated_at"`
	ClosedAt      *string      `json:"closed_at"`
	HTMLURL       string       `json:"html_url"`
}

func toPullJSON(pull *Pull, repo *Repo) pullJSON {
	userID := 999999
	if pull.UserLogin == viewerLogin {
		userID = viewerID
	}
	var closedAt *string
	if pull.State == "closed" {
		closedAt = &pull.UpdatedAt
	}
	return pullJSON{
		ID:     pull.ID,
		Number: pull.Number,
		Title:  pull.Title,
		Body:   pull.Body,
		State:  pull.State,
		Head:   pullHeadJSON{Ref: pull.HeadRef, Sha: pull.HeadSha, Label: repo.Owner + ":" + pull.HeadRef},
		Base:   pullHeadJSON{Ref: pull.BaseRef, Sha: pull.BaseSha, Label: repo.Owner + ":" + pull.BaseRef},
		Merged: pull.Merged,
		Mergeable: pull.Mergeable,
		MergeCommitSha: pull.MergeCommitSha,
		MergedAt:      pull.MergedAt,
		User:          issueUserJSON{Login: pull.UserLogin, ID: userID, Type: "User"},
		CreatedAt:     pull.CreatedAt,
		UpdatedAt:     pull.UpdatedAt,
		ClosedAt:      closedAt,
		HTMLURL:       "https://example.invalid/" + repo.Owner + "/" + repo.Name + "/pull/" + itoa(pull.Number),
	}
}

type commentJSON struct {
	ID        int           `json:"id"`
	Body      string        `json:"body"`
	User      issueUserJSON `json:"user"`
	CreatedAt string        `json:"created_at"`
	UpdatedAt string        `json:"updated_at"`
}

func toCommentJSON(c *Comment) commentJSON {
	userID := 999999
	if c.UserLogin == viewerLogin {
		userID = viewerID
	}
	return commentJSON{
		ID:        c.ID,
		Body:      c.Body,
		User:      issueUserJSON{Login: c.UserLogin, ID: userID, Type: "User"},
		CreatedAt: c.CreatedAt,
		UpdatedAt: c.UpdatedAt,
	}
}

// ---------------------------------------------------------------------------
// Git helpers for the contents API
// ---------------------------------------------------------------------------

func gitIdentity() string {
	return viewerName + " <" + viewerEmail + "> " + itoa(fixedEpoch) + " +0000"
}

// updateTree recursively sets (or deletes) a path in a tree; returns the new tree oid.
func updateTree(repo *Repo, treeOID *string, parts []string, blobOID *string) string {
	var entries []TreeEntry
	if treeOID != nil {
		entries = parseTree(getObject(repo, *treeOID).dataOrEmpty())
	}
	head := parts[0]
	rest := parts[1:]
	idx := -1
	for i, e := range entries {
		if e.Name == head {
			idx = i
			break
		}
	}
	if len(rest) == 0 {
		// Leaf.
		if blobOID == nil {
			if idx >= 0 {
				entries = append(entries[:idx], entries[idx+1:]...)
			}
		} else if idx >= 0 {
			entries[idx] = TreeEntry{Mode: "100644", Name: head, OID: *blobOID}
		} else {
			entries = append(entries, TreeEntry{Mode: "100644", Name: head, OID: *blobOID})
		}
	} else {
		var childTree *string
		if idx >= 0 {
			oid := entries[idx].OID
			childTree = &oid
		}
		newChild := updateTree(repo, childTree, rest, blobOID)
		childEntries := parseTree(getObject(repo, newChild).dataOrEmpty())
		if len(childEntries) == 0 {
			if idx >= 0 {
				entries = append(entries[:idx], entries[idx+1:]...)
			}
		} else if idx >= 0 {
			entries[idx] = TreeEntry{Mode: "040000", Name: head, OID: newChild}
		} else {
			entries = append(entries, TreeEntry{Mode: "040000", Name: head, OID: newChild})
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	return putObject(repo, "tree", serializeTree(entries))
}

func (o *GitObject) dataOrEmpty() []byte {
	if o == nil {
		return nil
	}
	return o.Data
}

// lookupPath returns the blob oid at a path in a tree, or nil.
func lookupPath(repo *Repo, treeOID *string, parts []string) (oid string, typ string, ok bool) {
	if treeOID == nil {
		return "", "", false
	}
	entries := parseTree(getObject(repo, *treeOID).dataOrEmpty())
	head := parts[0]
	rest := parts[1:]
	var entry *TreeEntry
	for i := range entries {
		if entries[i].Name == head {
			entry = &entries[i]
			break
		}
	}
	if entry == nil {
		return "", "", false
	}
	if len(rest) == 0 {
		obj := getObject(repo, entry.OID)
		if obj == nil {
			return "", "", false
		}
		if obj.Type == "tree" {
			return entry.OID, "tree", true
		}
		return entry.OID, "blob", true
	}
	if entry.Mode == "040000" {
		return lookupPath(repo, &entry.OID, rest)
	}
	return "", "", false
}

// listTree returns the entries of a directory tree.
func listTree(repo *Repo, treeOID *string) []TreeEntry {
	if treeOID == nil {
		return nil
	}
	return parseTree(getObject(repo, *treeOID).dataOrEmpty())
}

func commitAtRef(repo *Repo, ref string) (sha string, c Commit, ok bool) {
	oid, exists := repo.Refs[ref]
	if !exists {
		return "", Commit{}, false
	}
	obj := getObject(repo, oid)
	if obj == nil || obj.Type != "commit" {
		return "", Commit{}, false
	}
	return oid, parseCommit(obj.Data), true
}

func makeCommit(repo *Repo, treeOID string, parents []string, message string) string {
	data := serializeCommit(treeOID, parents, gitIdentity(), gitIdentity(), message)
	return putObject(repo, "commit", data)
}

// walkCommits walks commits from a tip, newest first (parents after children).
func walkCommits(repo *Repo, tip string) []string {
	var out []string
	seen := make(map[string]bool)
	queue := []string{tip}
	for len(queue) > 0 {
		oid := queue[0]
		queue = queue[1:]
		if seen[oid] {
			continue
		}
		seen[oid] = true
		obj := getObject(repo, oid)
		if obj == nil || obj.Type != "commit" {
			continue
		}
		out = append(out, oid)
		for _, p := range parseCommit(obj.Data).Parents {
			queue = append(queue, p)
		}
	}
	return out
}

// mergeBase returns the best common ancestor of two commits.
func mergeBase(repo *Repo, a, b string) string {
	ancestorsA := make(map[string]bool)
	for _, oid := range walkCommits(repo, a) {
		ancestorsA[oid] = true
	}
	queue := []string{b}
	seen := make(map[string]bool)
	for len(queue) > 0 {
		oid := queue[0]
		queue = queue[1:]
		if ancestorsA[oid] {
			return oid
		}
		if seen[oid] {
			continue
		}
		seen[oid] = true
		obj := getObject(repo, oid)
		if obj == nil || obj.Type != "commit" {
			continue
		}
		for _, p := range parseCommit(obj.Data).Parents {
			queue = append(queue, p)
		}
	}
	return ""
}

// flattenTree flattens a tree into path -> blob oid.
func flattenTree(repo *Repo, treeOID *string, prefix string, out map[string]string) {
	if treeOID == nil {
		return
	}
	for _, e := range parseTree(getObject(repo, *treeOID).dataOrEmpty()) {
		path := e.Name
		if prefix != "" {
			path = prefix + "/" + e.Name
		}
		if e.Mode == "040000" {
			oid := e.OID
			flattenTree(repo, &oid, path, out)
		} else {
			out[path] = e.OID
		}
	}
}

// lineDiff is a naive line diff: additions = lines in new not in old,
// deletions = lines in old not in new.
func lineDiff(oldText, newText string) (additions, deletions int) {
	var oldLines, newLines []string
	if oldText != "" {
		oldLines = strings.Split(oldText, "\n")
	}
	if newText != "" {
		newLines = strings.Split(newText, "\n")
	}
	oldCount := make(map[string]int)
	for _, l := range oldLines {
		oldCount[l]++
	}
	for _, l := range newLines {
		if n := oldCount[l]; n > 0 {
			oldCount[l] = n - 1
		} else {
			additions++
		}
	}
	for _, n := range oldCount {
		deletions += n
	}
	return additions, deletions
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

type restRouter struct {
	store       *Store
	viewerToken string
	// Per-repo response cache for hot list endpoints; cleared on mutation.
	listCache map[string]string
}

func newRestRouter(store *Store, viewerToken string) *restRouter {
	return &restRouter{store: store, viewerToken: viewerToken, listCache: make(map[string]string)}
}

func (r *restRouter) clearListCache(repo *Repo) {
	prefix := repo.Owner + "/" + repo.Name + ":"
	for k := range r.listCache {
		if strings.HasPrefix(k, prefix) {
			delete(r.listCache, k)
		}
	}
}

func (r *restRouter) handle(req *httpRequest) *httpResponse {
	// The whole REST request runs under the store write lock: REST handlers
	// mutate shared maps, and the workloads are sequential, so one lock keeps
	// every map access safe without measurable cost here.
	r.store.mu.Lock()
	defer r.store.mu.Unlock()
	segments := splitPath(req.Path)
	// All routes live under /api/v3.
	if len(segments) < 2 || segments[0] != "api" || segments[1] != "v3" {
		return withRequestID(errorResponse(404, "Not Found"))
	}
	rest := segments[2:]
	// The API root and /meta are public.
	if len(rest) == 0 {
		if req.Method != "GET" {
			return withRequestID(errorResponse(404, "Not Found"))
		}
		return withRequestID(jsonResponse(200, map[string]string{
			"current_user_url":  "/api/v3/user",
			"repository_url":    "/api/v3/repos/{owner}/{repo}",
			"rate_limit_url":    "/api/v3/rate_limit",
		}, map[string]string{"x-oauth-scopes": "repo, user", "x-accepted-oauth-scopes": "repo, user"}))
	}
	if len(rest) == 1 && rest[0] == "meta" {
		if req.Method != "GET" {
			return withRequestID(errorResponse(404, "Not Found"))
		}
		return withRequestID(jsonResponse(200, map[string]string{"installed_version": "1.0.0"}))
	}
	id := authenticate(req, r.viewerToken)
	if id == nil {
		return withRequestID(errorResponse(401, "Requires authentication"))
	}
	res := r.dispatch(req, id, rest)
	return withRequestID(res)
}

func splitPath(p string) []string {
	parts := strings.Split(p, "/")
	var out []string
	for _, s := range parts {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func (r *restRouter) dispatch(req *httpRequest, id *identity, rest []string) *httpResponse {
	method := req.Method
	// /user/repos
	if len(rest) == 2 && rest[0] == "user" && rest[1] == "repos" {
		if method == "POST" {
			return r.createRepo(req, id)
		}
		if method == "GET" {
			return r.listUserRepos(req, id)
		}
		return errorResponse(404, "Not Found")
	}
	// /repos/{owner}/{repo}[...]
	if rest[0] == "repos" && len(rest) >= 3 {
		owner := decodeSegment(rest[1])
		repoName := decodeSegment(rest[2])
		repo := r.store.getRepo(owner, repoName)
		if repo == nil {
			return errorResponse(404, "Not Found")
		}
		// A stranger owns nothing here; the viewer's repos are not theirs to read.
		if !id.isViewer && repo.Owner == viewerLogin {
			return errorResponse(404, "Not Found")
		}
		return r.repoDispatch(req, id, repo, rest[3:])
	}
	return errorResponse(404, "Not Found")
}

func (r *restRouter) createRepo(req *httpRequest, id *identity) *httpResponse {
	body, errResp := parseJSONBody(req)
	if errResp != nil {
		return errResp
	}
	name := ""
	if s, ok := body["name"].(string); ok {
		name = strings.TrimSpace(s)
	}
	if name == "" {
		return errorResponse(422, "name is required")
	}
	owner := id.login
	if r.store.getRepo(owner, name) != nil {
		return errorResponse(422, "Repository already exists")
	}
	isPrivate := body["private"] == true
	description := ""
	if s, ok := body["description"].(string); ok {
		description = s
	}
	defaultBranch := "main"
	if s, ok := body["default_branch"].(string); ok && s != "" {
		defaultBranch = s
	}
	repo := r.store.createRepo(owner, name, isPrivate, description, defaultBranch)
	return jsonResponse(201, toRepoJSON(repo))
}

func (r *restRouter) listUserRepos(req *httpRequest, id *identity) *httpResponse {
	perPage := clampInt(parseQueryInt(req.queryGet("per_page"), 30), 1, 100)
	page := maxInt(parseQueryInt(req.queryGet("page"), 1), 1)
	var all []*Repo
	for _, repo := range r.store.repos {
		if repo.Owner == id.login {
			all = append(all, repo)
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].ID < all[j].ID })
	start := (page - 1) * perPage
	if start > len(all) {
		start = len(all)
	}
	end := page * perPage
	if end > len(all) {
		end = len(all)
	}
	slice := all[start:end]
	headers := map[string]string{}
	if page*perPage < len(all) {
		nextURL := "http://" + req.Host + "/api/v3/user/repos?per_page=" + itoa(perPage) + "&page=" + itoa(page+1)
		headers["link"] = "<" + nextURL + ">; rel=\"next\""
	}
	list := make([]repoJSON, 0, len(slice))
	for _, repo := range slice {
		list = append(list, toRepoJSON(repo))
	}
	return jsonResponse(200, list, headers)
}

func parseQueryInt(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

func clampInt(n, lo, hi int) int {
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// ---------------------------------------------------------------------------

func (r *restRouter) repoDispatch(req *httpRequest, id *identity, repo *Repo, tail []string) *httpResponse {
	method := req.Method
	if len(tail) == 0 {
		if method == "GET" {
			return jsonResponse(200, toRepoJSON(repo))
		}
		if method == "PATCH" {
			body, errResp := parseJSONBody(req)
			if errResp != nil {
				return errResp
			}
			if s, ok := body["description"].(string); ok {
				repo.Description = s
			}
			if s, ok := body["default_branch"].(string); ok && s != "" {
				repo.DefaultBranch = s
			}
			r.clearListCache(repo)
			return jsonResponse(200, toRepoJSON(repo))
		}
		if method == "DELETE" {
			r.store.deleteRepo(repo.Owner, repo.Name)
			r.clearListCache(repo)
			return &httpResponse{Status: 204, Headers: map[string]string{}, Body: []byte{}}
		}
		return errorResponse(404, "Not Found")
	}
	head := tail[0]
	if head == "branches" && len(tail) == 1 && method == "GET" {
		cacheKey := repo.Owner + "/" + repo.Name + ":branches"
		if cached, ok := r.listCache[cacheKey]; ok {
			return jsonResponse(200, cached)
		}
		type branch struct {
			Name      string `json:"name"`
			Commit    any    `json:"commit"`
			Protected bool   `json:"protected"`
		}
		var names []string
		for name := range repo.Refs {
			if strings.HasPrefix(name, "refs/heads/") {
				names = append(names, name)
			}
		}
		sort.Strings(names)
		list := make([]branch, 0, len(names))
		for _, name := range names {
			list = append(list, branch{
				Name:      name[len("refs/heads/"):],
				Commit:    map[string]string{"sha": repo.Refs[name]},
				Protected: false,
			})
		}
		body := string(marshalJSON(list))
		r.listCache[cacheKey] = body
		return jsonResponse(200, body)
	}
	if head == "commits" && len(tail) == 1 && method == "GET" {
		return r.listCommits(req, repo)
	}
	if head == "git" && len(tail) >= 2 && tail[1] == "refs" {
		if method == "POST" && len(tail) == 2 {
			return r.createRef(req, repo)
		}
		if method == "GET" && len(tail) > 2 {
			return r.getRef(repo, strings.Join(tail[2:], "/"))
		}
		return errorResponse(404, "Not Found")
	}
	if head == "contents" {
		path := ""
		var parts []string
		for _, seg := range tail[1:] {
			parts = append(parts, decodeSegment(seg))
		}
		path = strings.Join(parts, "/")
		if method == "PUT" {
			return r.putContents(req, repo, path)
		}
		if method == "GET" {
			return r.getContents(req, repo, path)
		}
		if method == "DELETE" {
			return r.deleteContents(req, repo, path)
		}
		return errorResponse(404, "Not Found")
	}
	if head == "labels" {
		if method == "POST" && len(tail) == 1 {
			return r.createLabel(req, repo)
		}
		if method == "GET" && len(tail) == 1 {
			list := make([]labelJSON, 0, len(repo.Labels))
			names := make([]string, 0, len(repo.Labels))
			for n := range repo.Labels {
				names = append(names, n)
			}
			sort.Strings(names)
			for _, n := range names {
				list = append(list, toLabelJSON(repo.Labels[n]))
			}
			return jsonResponse(200, list)
		}
		return errorResponse(404, "Not Found")
	}
	if head == "issues" {
		if len(tail) == 1 {
			if method == "POST" {
				return r.createIssue(req, repo)
			}
			if method == "GET" {
				return r.listIssues(req, repo)
			}
		}
		if num, err := strconv.Atoi(tail[1]); err == nil {
			if len(tail) == 2 {
				if method == "GET" {
					return r.getIssue(repo, num)
				}
				if method == "PATCH" {
					return r.patchIssue(req, repo, num)
				}
			}
			if len(tail) == 3 && tail[2] == "comments" {
				if method == "POST" {
					return r.createComment(req, repo, num)
				}
				if method == "GET" {
					return r.listComments(repo, num)
				}
			}
		}
		return errorResponse(404, "Not Found")
	}
	if head == "pulls" {
		if len(tail) == 1 {
			if method == "POST" {
				return r.createPull(req, repo)
			}
			if method == "GET" {
				return r.listPulls(req, repo)
			}
		}
		if num, err := strconv.Atoi(tail[1]); err == nil {
			if len(tail) == 2 && method == "GET" {
				return r.getPull(repo, num)
			}
			if len(tail) == 3 && tail[2] == "files" && method == "GET" {
				return r.pullFiles(repo, num)
			}
			if len(tail) == 3 && tail[2] == "merge" && method == "PUT" {
				return r.mergePull(req, repo, num)
			}
		}
		return errorResponse(404, "Not Found")
	}
	return errorResponse(404, "Not Found")
}

// ---------------------------------------------------------------------------

func (r *restRouter) listCommits(req *httpRequest, repo *Repo) *httpResponse {
	refName := req.queryGet("sha")
	if refName == "" {
		refName = repo.DefaultBranch
	}
	ref := refName
	if !strings.HasPrefix(ref, "refs/") {
		ref = "refs/heads/" + refName
	}
	tip, exists := repo.Refs[ref]
	if !exists {
		return errorResponse(404, "No such ref")
	}
	cacheKey := repo.Owner + "/" + repo.Name + ":commits:" + ref + ":" + tip
	if cached, ok := r.listCache[cacheKey]; ok {
		return jsonResponse(200, cached)
	}
	perPage := clampInt(parseQueryInt(req.queryGet("per_page"), 30), 1, 100)
	page := maxInt(parseQueryInt(req.queryGet("page"), 1), 1)
	all := walkCommits(repo, tip)
	start := (page - 1) * perPage
	if start > len(all) {
		start = len(all)
	}
	end := page * perPage
	if end > len(all) {
		end = len(all)
	}
	type commitJSON struct {
		Sha     string `json:"sha"`
		Commit  any    `json:"commit"`
		Author  any    `json:"author"`
		Parents []any  `json:"parents"`
	}
	list := make([]commitJSON, 0, end-start)
	for _, sha := range all[start:end] {
		c := parseCommit(getObject(repo, sha).dataOrEmpty())
		parents := make([]any, 0, len(c.Parents))
		for _, p := range c.Parents {
			parents = append(parents, map[string]string{"sha": p})
		}
		list = append(list, commitJSON{
			Sha: sha,
			Commit: map[string]any{
				"message": c.Message,
				"author":  map[string]string{"name": viewerName, "email": viewerEmail, "date": fixedISO},
				"committer": map[string]string{"name": viewerName, "email": viewerEmail, "date": fixedISO},
			},
			Author:  map[string]any{"login": viewerLogin, "id": viewerID, "type": "User"},
			Parents: parents,
		})
	}
	body := string(marshalJSON(list))
	r.listCache[cacheKey] = body
	return jsonResponse(200, body)
}

func (r *restRouter) createRef(req *httpRequest, repo *Repo) *httpResponse {
	body, errResp := parseJSONBody(req)
	if errResp != nil {
		return errResp
	}
	ref, _ := body["ref"].(string)
	sha, _ := body["sha"].(string)
	if !strings.HasPrefix(ref, "refs/") || sha == "" {
		return errorResponse(422, "ref and sha are required")
	}
	if _, exists := repo.Refs[ref]; exists {
		return errorResponse(422, "Reference already exists")
	}
	obj := getObject(repo, sha)
	if obj == nil || obj.Type != "commit" {
		return errorResponse(422, "Object does not exist")
	}
	repo.Refs[ref] = sha
	r.store.touchRefs(repo)
	r.clearListCache(repo)
	return jsonResponse(201, map[string]any{"ref": ref, "object": map[string]string{"sha": sha, "type": "commit"}})
}

func (r *restRouter) getRef(repo *Repo, refPath string) *httpResponse {
	ref := "refs/" + refPath
	oid, ok := repo.Refs[ref]
	if !ok {
		return errorResponse(404, "Not Found")
	}
	return jsonResponse(200, map[string]any{"ref": ref, "object": map[string]string{"sha": oid, "type": "commit"}})
}

// ---------------------------------------------------------------------------

func (r *restRouter) putContents(req *httpRequest, repo *Repo, path string) *httpResponse {
	body, errResp := parseJSONBody(req)
	if errResp != nil {
		return errResp
	}
	message, _ := body["message"].(string)
	if message == "" {
		message = "Update file"
	}
	contentB64, _ := body["content"].(string)
	content, err := base64.StdEncoding.DecodeString(contentB64)
	if err != nil {
		return errorResponse(400, "content is not valid base64")
	}
	branch, _ := body["branch"].(string)
	if branch == "" {
		branch = repo.DefaultBranch
	}
	ref := "refs/heads/" + branch
	tipSha, tipCommit, tipOK := commitAtRef(repo, ref)
	parts := splitNonEmpty(path, "/")
	if len(parts) == 0 {
		return errorResponse(422, "path is required")
	}
	var existingOID, existingType string
	var existingOK bool
	if tipOK {
		tree := tipCommit.Tree
		existingOID, existingType, existingOK = lookupPath(repo, &tree, parts)
	}
	isUpdate := existingOK && existingType == "blob"
	if isUpdate {
		sha, _ := body["sha"].(string)
		if sha != "" && !strings.EqualFold(sha, existingOID) {
			return errorResponse(409, "sha does not match the current blob")
		}
	}
	blobOID := putObject(repo, "blob", content)
	var tipTree *string
	if tipOK {
		t := tipCommit.Tree
		tipTree = &t
	}
	newTree := updateTree(repo, tipTree, parts, &blobOID)
	var parents []string
	if tipOK {
		parents = []string{tipSha}
	}
	commitSha := makeCommit(repo, newTree, parents, message)
	repo.Refs[ref] = commitSha
	r.store.touchRefs(repo)
	r.clearListCache(repo)
	return jsonResponse(boolToStatus(isUpdate, 200, 201), map[string]any{
		"content": map[string]any{
			"name":     parts[len(parts)-1],
			"path":     path,
			"sha":      blobOID,
			"size":     len(content),
			"encoding": "base64",
			"content":  base64.StdEncoding.EncodeToString(content),
			"type":     "file",
		},
		"commit": map[string]string{"sha": commitSha, "message": message},
	})
}

func boolToStatus(cond bool, a, b int) int {
	if cond {
		return a
	}
	return b
}

func splitNonEmpty(s, sep string) []string {
	var out []string
	for _, p := range strings.Split(s, sep) {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func (r *restRouter) getContents(req *httpRequest, repo *Repo, path string) *httpResponse {
	refName := req.queryGet("ref")
	if refName == "" {
		refName = repo.DefaultBranch
	}
	ref := refName
	if !strings.HasPrefix(ref, "refs/") {
		ref = "refs/heads/" + refName
	}
	_, tipCommit, tipOK := commitAtRef(repo, ref)
	if !tipOK {
		return errorResponse(404, "Not Found")
	}
	parts := splitNonEmpty(path, "/")
	if len(parts) == 0 {
		// Root listing.
		tree := tipCommit.Tree
		entries := listTree(repo, &tree)
		return jsonResponse(200, contentEntries(repo, entries, ""))
	}
	tree := tipCommit.Tree
	foundOID, foundType, foundOK := lookupPath(repo, &tree, parts)
	if !foundOK {
		return errorResponse(404, "Not Found")
	}
	if foundType == "tree" {
		entries := listTree(repo, &foundOID)
		return jsonResponse(200, contentEntries(repo, entries, path))
	}
	obj := getObject(repo, foundOID)
	if obj == nil {
		return errorResponse(404, "Not Found")
	}
	return jsonResponse(200, map[string]any{
		"type":     "file",
		"encoding": "base64",
		"content":  base64.StdEncoding.EncodeToString(obj.Data),
		"sha":      foundOID,
		"size":     len(obj.Data),
		"name":     parts[len(parts)-1],
		"path":     path,
	})
}

func contentEntries(repo *Repo, entries []TreeEntry, prefix string) []map[string]any {
	out := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		typ := "file"
		size := 0
		if e.Mode == "040000" {
			typ = "dir"
		} else {
			if obj := getObject(repo, e.OID); obj != nil {
				size = len(obj.Data)
			}
		}
		p := e.Name
		if prefix != "" {
			p = prefix + "/" + e.Name
		}
		out = append(out, map[string]any{
			"type": typ,
			"name": e.Name,
			"path": p,
			"sha":  e.OID,
			"size": size,
		})
	}
	return out
}

func (r *restRouter) deleteContents(req *httpRequest, repo *Repo, path string) *httpResponse {
	body, errResp := parseJSONBody(req)
	if errResp != nil {
		return errResp
	}
	message, _ := body["message"].(string)
	if message == "" {
		message = "Delete file"
	}
	branch, _ := body["branch"].(string)
	if branch == "" {
		branch = repo.DefaultBranch
	}
	ref := "refs/heads/" + branch
	tipSha, tipCommit, tipOK := commitAtRef(repo, ref)
	if !tipOK {
		return errorResponse(404, "Not Found")
	}
	parts := splitNonEmpty(path, "/")
	tree := tipCommit.Tree
	existingOID, existingType, existingOK := lookupPath(repo, &tree, parts)
	if !existingOK || existingType != "blob" {
		return errorResponse(404, "Not Found")
	}
	sha, _ := body["sha"].(string)
	if sha != "" && !strings.EqualFold(sha, existingOID) {
		return errorResponse(409, "sha does not match the current blob")
	}
	newTree := updateTree(repo, &tree, parts, nil)
	commitSha := makeCommit(repo, newTree, []string{tipSha}, message)
	repo.Refs[ref] = commitSha
	r.store.touchRefs(repo)
	r.clearListCache(repo)
	return jsonResponse(200, map[string]any{"commit": map[string]string{"sha": commitSha, "message": message}})
}

// ---------------------------------------------------------------------------

func (r *restRouter) createLabel(req *httpRequest, repo *Repo) *httpResponse {
	body, errResp := parseJSONBody(req)
	if errResp != nil {
		return errResp
	}
	name := ""
	if s, ok := body["name"].(string); ok {
		name = strings.TrimSpace(s)
	}
	if name == "" {
		return errorResponse(422, "name is required")
	}
	color, _ := body["color"].(string)
	if color == "" {
		color = "ededed"
	}
	description, _ := body["description"].(string)
	label := &Label{Name: name, Color: color, Description: description}
	repo.Labels[name] = label
	return jsonResponse(201, toLabelJSON(label))
}

func labelNamesOf(body map[string]any) []string {
	var names []string
	if arr, ok := body["labels"].([]any); ok {
		for _, l := range arr {
			if s, ok := l.(string); ok {
				names = append(names, s)
			} else if m, ok := l.(map[string]any); ok {
				if s, ok := m["name"].(string); ok {
					names = append(names, s)
				}
			}
		}
	}
	return names
}

func (r *restRouter) createIssue(req *httpRequest, repo *Repo) *httpResponse {
	body, errResp := parseJSONBody(req)
	if errResp != nil {
		return errResp
	}
	title, _ := body["title"].(string)
	if title == "" {
		return errorResponse(422, "title is required")
	}
	bodyText, _ := body["body"].(string)
	var labels []*Label
	for _, name := range labelNamesOf(body) {
		label, ok := repo.Labels[name]
		if !ok {
			return errorResponse(422, "Label does not exist: "+name)
		}
		labels = append(labels, label)
	}
	repo.IssueCounter++
	issue := &Issue{
		ID:        r.store.nextGlobalID(),
		Number:    repo.IssueCounter,
		Title:     title,
		Body:      bodyText,
		State:     "open",
		Labels:    labels,
		UserLogin: viewerLogin,
		CreatedAt: fixedISO,
		UpdatedAt: fixedISO,
		ClosedAt:  nil,
		Comments:  []*Comment{},
	}
	issue.JSONCache = renderIssueJSON(issue, repo)
	repo.Issues[issue.Number] = issue
	r.clearListCache(repo)
	return jsonResponse(201, issue.JSONCache)
}

func (r *restRouter) listIssues(req *httpRequest, repo *Repo) *httpResponse {
	state := req.queryGet("state")
	if state == "" {
		state = "open"
	}
	sortBy := req.queryGet("sort")
	if sortBy == "" {
		sortBy = "created"
	}
	direction := req.queryGet("direction")
	if direction == "" {
		direction = "desc"
	}
	cacheKey := repo.Owner + "/" + repo.Name + ":issues:" + state + ":" + sortBy + ":" + direction
	if cached, ok := r.listCache[cacheKey]; ok {
		return jsonResponse(200, cached)
	}
	var list []*Issue
	for _, i := range repo.Issues {
		if state != "all" && i.State != state {
			continue
		}
		list = append(list, i)
	}
	if sortBy == "created" {
		sort.Slice(list, func(a, b int) bool {
			if direction == "asc" {
				return list[a].Number < list[b].Number
			}
			return list[a].Number > list[b].Number
		})
	}
	out := make([]issueJSON, 0, len(list))
	for _, i := range list {
		out = append(out, toIssueJSON(i, repo))
	}
	body := string(marshalJSON(out))
	r.listCache[cacheKey] = body
	return jsonResponse(200, body)
}

func (r *restRouter) getIssue(repo *Repo, num int) *httpResponse {
	issue, ok := repo.Issues[num]
	if !ok {
		return errorResponse(404, "Not Found")
	}
	if issue.JSONCache != "" {
		return jsonResponse(200, issue.JSONCache)
	}
	return jsonResponse(200, renderIssueJSON(issue, repo))
}

func (r *restRouter) patchIssue(req *httpRequest, repo *Repo, num int) *httpResponse {
	issue, ok := repo.Issues[num]
	if !ok {
		return errorResponse(404, "Not Found")
	}
	body, errResp := parseJSONBody(req)
	if errResp != nil {
		return errResp
	}
	if s, ok := body["title"].(string); ok {
		issue.Title = s
	}
	if s, ok := body["body"].(string); ok {
		issue.Body = s
	}
	if s, ok := body["state"].(string); ok && (s == "open" || s == "closed") {
		issue.State = s
		if s == "closed" {
			closed := fixedISO
			issue.ClosedAt = &closed
		} else {
			issue.ClosedAt = nil
		}
	}
	if arr, ok := body["labels"].([]any); ok {
		var labels []*Label
		for _, l := range arr {
			var name string
			if s, ok := l.(string); ok {
				name = s
			} else if m, ok := l.(map[string]any); ok {
				name, _ = m["name"].(string)
			}
			label, ok := repo.Labels[name]
			if !ok {
				return errorResponse(422, "Label does not exist: "+name)
			}
			labels = append(labels, label)
		}
		issue.Labels = labels
	}
	issue.JSONCache = renderIssueJSON(issue, repo)
	r.clearListCache(repo)
	return jsonResponse(200, issue.JSONCache)
}

func (r *restRouter) createComment(req *httpRequest, repo *Repo, num int) *httpResponse {
	issue, ok := repo.Issues[num]
	if !ok {
		return errorResponse(404, "Not Found")
	}
	body, errResp := parseJSONBody(req)
	if errResp != nil {
		return errResp
	}
	bodyText, _ := body["body"].(string)
	if bodyText == "" {
		return errorResponse(422, "body is required")
	}
	comment := &Comment{
		ID:        r.store.nextGlobalID(),
		Body:      bodyText,
		UserLogin: viewerLogin,
		CreatedAt: fixedISO,
		UpdatedAt: fixedISO,
	}
	issue.Comments = append(issue.Comments, comment)
	repo.CommentCounter++
	issue.JSONCache = renderIssueJSON(issue, repo)
	r.clearListCache(repo)
	return jsonResponse(201, toCommentJSON(comment))
}

func (r *restRouter) listComments(repo *Repo, num int) *httpResponse {
	issue, ok := repo.Issues[num]
	if !ok {
		return errorResponse(404, "Not Found")
	}
	list := make([]commentJSON, 0, len(issue.Comments))
	for _, c := range issue.Comments {
		list = append(list, toCommentJSON(c))
	}
	return jsonResponse(200, list)
}

// ---------------------------------------------------------------------------

func (r *restRouter) createPull(req *httpRequest, repo *Repo) *httpResponse {
	body, errResp := parseJSONBody(req)
	if errResp != nil {
		return errResp
	}
	title, _ := body["title"].(string)
	if title == "" {
		return errorResponse(422, "title is required")
	}
	headRef, _ := body["head"].(string)
	baseRef, _ := body["base"].(string)
	headName := headRef
	if i := strings.LastIndex(headRef, ":"); i >= 0 {
		headName = headRef[i+1:]
	}
	baseName := baseRef
	if i := strings.LastIndex(baseRef, ":"); i >= 0 {
		baseName = baseRef[i+1:]
	}
	headSha, okH := repo.Refs["refs/heads/"+headName]
	baseSha, okB := repo.Refs["refs/heads/"+baseName]
	if !okH || !okB {
		return errorResponse(422, "head or base branch does not exist")
	}
	repo.PullCounter++
	pull := &Pull{
		ID:        r.store.nextGlobalID(),
		Number:    repo.PullCounter,
		Title:     title,
		Body:      stringVal(body["body"]),
		State:     "open",
		HeadRef:   headName,
		BaseRef:   baseName,
		HeadSha:   headSha,
		BaseSha:   baseSha,
		Merged:    false,
		Mergeable: true,
		UserLogin: viewerLogin,
		CreatedAt: fixedISO,
		UpdatedAt: fixedISO,
	}
	repo.Pulls[pull.Number] = pull
	r.clearListCache(repo)
	return jsonResponse(201, toPullJSON(pull, repo))
}

func stringVal(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func (r *restRouter) listPulls(req *httpRequest, repo *Repo) *httpResponse {
	state := req.queryGet("state")
	if state == "" {
		state = "open"
	}
	cacheKey := repo.Owner + "/" + repo.Name + ":pulls:" + state
	if cached, ok := r.listCache[cacheKey]; ok {
		return jsonResponse(200, cached)
	}
	var list []*Pull
	for _, p := range repo.Pulls {
		if state != "all" && p.State != state {
			continue
		}
		list = append(list, p)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Number > list[j].Number })
	out := make([]pullJSON, 0, len(list))
	for _, p := range list {
		out = append(out, toPullJSON(p, repo))
	}
	body := string(marshalJSON(out))
	r.listCache[cacheKey] = body
	return jsonResponse(200, body)
}

func (r *restRouter) getPull(repo *Repo, num int) *httpResponse {
	pull, ok := repo.Pulls[num]
	if !ok {
		return errorResponse(404, "Not Found")
	}
	return jsonResponse(200, toPullJSON(pull, repo))
}

func (r *restRouter) pullFiles(repo *Repo, num int) *httpResponse {
	pull, ok := repo.Pulls[num]
	if !ok {
		return errorResponse(404, "Not Found")
	}
	baseTipSha, baseTip, baseOK := commitAtRef(repo, "refs/heads/"+pull.BaseRef)
	headTipSha, headTip, headOK := commitAtRef(repo, "refs/heads/"+pull.HeadRef)
	_ = baseTipSha
	_ = headTipSha
	var baseTree, headTree *string
	if baseOK {
		t := baseTip.Tree
		baseTree = &t
	}
	if headOK {
		t := headTip.Tree
		headTree = &t
	}
	baseFiles := make(map[string]string)
	headFiles := make(map[string]string)
	flattenTree(repo, baseTree, "", baseFiles)
	flattenTree(repo, headTree, "", headFiles)
	paths := make(map[string]bool)
	for p := range baseFiles {
		paths[p] = true
	}
	for p := range headFiles {
		paths[p] = true
	}
	var sortedPaths []string
	for p := range paths {
		sortedPaths = append(sortedPaths, p)
	}
	sort.Strings(sortedPaths)
	type fileEntry struct {
		Filename  string `json:"filename"`
		Status    string `json:"status"`
		Additions int    `json:"additions"`
		Deletions int    `json:"deletions"`
		Changes   int    `json:"changes"`
	}
	var files []fileEntry
	for _, path := range sortedPaths {
		baseOID, inBase := baseFiles[path]
		headOID, inHead := headFiles[path]
		if inBase && !inHead {
			oldText := ""
			if obj := getObject(repo, baseOID); obj != nil {
				oldText = string(obj.Data)
			}
			_, del := lineDiff(oldText, "")
			files = append(files, fileEntry{Filename: path, Status: "removed", Additions: 0, Deletions: del, Changes: del})
		} else if !inBase && inHead {
			newText := ""
			if obj := getObject(repo, headOID); obj != nil {
				newText = string(obj.Data)
			}
			add, _ := lineDiff("", newText)
			files = append(files, fileEntry{Filename: path, Status: "added", Additions: add, Deletions: 0, Changes: add})
		} else {
			if baseOID == headOID {
				continue
			}
			oldText := ""
			newText := ""
			if obj := getObject(repo, baseOID); obj != nil {
				oldText = string(obj.Data)
			}
			if obj := getObject(repo, headOID); obj != nil {
				newText = string(obj.Data)
			}
			add, del := lineDiff(oldText, newText)
			files = append(files, fileEntry{Filename: path, Status: "modified", Additions: add, Deletions: del, Changes: add + del})
		}
	}
	if files == nil {
		files = []fileEntry{}
	}
	return jsonResponse(200, files)
}

func (r *restRouter) mergePull(req *httpRequest, repo *Repo, num int) *httpResponse {
	pull, ok := repo.Pulls[num]
	if !ok {
		return errorResponse(404, "Not Found")
	}
	if pull.State != "open" || pull.Merged {
		return errorResponse(405, "Pull request is not open")
	}
	body, errResp := parseJSONBody(req)
	if errResp != nil {
		return errResp
	}
	method, _ := body["merge_method"].(string)
	if method == "" {
		method = "squash"
	}
	message, _ := body["commit_message"].(string)
	if message == "" {
		message = "Merge pull request #" + itoa(pull.Number) + ": " + pull.Title
	}
	baseTipSha, baseTip, baseOK := commitAtRef(repo, "refs/heads/"+pull.BaseRef)
	headTipSha, headTip, headOK := commitAtRef(repo, "refs/heads/"+pull.HeadRef)
	if !baseOK || !headOK {
		return errorResponse(422, "head or base branch is missing")
	}
	// Three-way conflict detection against the merge base.
	base := mergeBase(repo, baseTipSha, headTipSha)
	var baseTree *string
	if base != "" {
		t := parseCommit(getObject(repo, base).dataOrEmpty()).Tree
		baseTree = &t
	}
	baseFiles := make(map[string]string)
	headFiles := make(map[string]string)
	tipFiles := make(map[string]string)
	flattenTree(repo, baseTree, "", baseFiles)
	headTree := headTip.Tree
	flattenTree(repo, &headTree, "", headFiles)
	baseTree2 := baseTip.Tree
	flattenTree(repo, &baseTree2, "", tipFiles)
	paths := make(map[string]bool)
	for p := range baseFiles {
		paths[p] = true
	}
	for p := range headFiles {
		paths[p] = true
	}
	for p := range tipFiles {
		paths[p] = true
	}
	for p := range paths {
		b, hasB := baseFiles[p]
		h, hasH := headFiles[p]
		t, hasT := tipFiles[p]
		bv := ""
		hv := ""
		tv := ""
		if hasB {
			bv = b
		}
		if hasH {
			hv = h
		}
		if hasT {
			tv = t
		}
		headChanged := hv != bv
		tipChanged := tv != bv
		if headChanged && tipChanged && hv != tv {
			return errorResponse(405, "Merge conflict")
		}
	}
	var mergeSha string
	if method == "merge" {
		mergeSha = makeCommit(repo, headTip.Tree, []string{baseTipSha, headTipSha}, message)
	} else {
		// squash (and rebase): one commit on the base branch with the head's tree.
		mergeSha = makeCommit(repo, headTip.Tree, []string{baseTipSha}, message)
	}
	repo.Refs["refs/heads/"+pull.BaseRef] = mergeSha
	pull.State = "closed"
	pull.Merged = true
	pull.MergeCommitSha = &mergeSha
	mergedAt := fixedISO
	pull.MergedAt = &mergedAt
	pull.UpdatedAt = fixedISO
	pull.BaseSha = mergeSha
	r.store.touchRefs(repo)
	r.clearListCache(repo)
	return jsonResponse(200, map[string]any{"sha": mergeSha, "merged": true, "message": message})
}
