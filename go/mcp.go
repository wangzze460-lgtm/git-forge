// MCP (Model Context Protocol) over Streamable HTTP at POST /mcp.
// Modern era (2026-07-28): server/discover is mandatory. Legacy: initialize +
// notifications/initialized + Mcp-Session-Id. tools/list is a precomputed
// constant so two calls are byte-identical. Tool results carry the same JSON
// shapes as REST.

package main

import (
	"encoding/json"
	"strings"
)

const serverName = "forge"
const serverVersion = "1.0.0"
const sessionID = "session-1"

var supportedVersions = []string{"2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

// The tools/list result, precomputed once so two calls are byte-identical.
// Field and property order matches the Node TOOLS array exactly.
const toolsListJSON = `{"tools":[{"name":"create_repo","description":"Create a new repository owned by the viewer.","inputSchema":{"type":"object","properties":{"name":{"type":"string","description":"Repository name"},"description":{"type":"string","description":"Repository description"},"private":{"type":"boolean","description":"Whether the repository is private"}},"required":["name"]}},{"name":"get_repo","description":"Get a repository by owner and name.","inputSchema":{"type":"object","properties":{"owner":{"type":"string","description":"Repository owner login"},"repo":{"type":"string","description":"Repository name"}},"required":["owner","repo"]}},{"name":"create_issue","description":"Create an issue in a repository.","inputSchema":{"type":"object","properties":{"owner":{"type":"string","description":"Repository owner login"},"repo":{"type":"string","description":"Repository name"},"title":{"type":"string","description":"Issue title"},"body":{"type":"string","description":"Issue body"},"labels":{"type":"array","description":"Label names","items":{"type":"string"}}},"required":["owner","repo","title"]}},{"name":"list_issues","description":"List issues in a repository.","inputSchema":{"type":"object","properties":{"owner":{"type":"string","description":"Repository owner login"},"repo":{"type":"string","description":"Repository name"},"state":{"type":"string","description":"Issue state: open, closed or all"}},"required":["owner","repo"]}},{"name":"create_pull_request","description":"Create a pull request from a head branch into a base branch.","inputSchema":{"type":"object","properties":{"owner":{"type":"string","description":"Repository owner login"},"repo":{"type":"string","description":"Repository name"},"title":{"type":"string","description":"Pull request title"},"head":{"type":"string","description":"Head branch name"},"base":{"type":"string","description":"Base branch name"},"body":{"type":"string","description":"Pull request body"}},"required":["owner","repo","title","head","base"]}},{"name":"merge_pull_request","description":"Merge a pull request (squash) into its base branch.","inputSchema":{"type":"object","properties":{"owner":{"type":"string","description":"Repository owner login"},"repo":{"type":"string","description":"Repository name"},"pull_number":{"type":"integer","description":"Pull request number"}},"required":["owner","repo","pull_number"]}},{"name":"get_issue","description":"Get one issue by number.","inputSchema":{"type":"object","properties":{"owner":{"type":"string","description":"Repository owner login"},"repo":{"type":"string","description":"Repository name"},"issue_number":{"type":"integer","description":"Issue number"}},"required":["owner","repo","issue_number"]}},{"name":"create_comment","description":"Add a comment to an issue.","inputSchema":{"type":"object","properties":{"owner":{"type":"string","description":"Repository owner login"},"repo":{"type":"string","description":"Repository name"},"issue_number":{"type":"integer","description":"Issue number"},"body":{"type":"string","description":"Comment body"}},"required":["owner","repo","issue_number","body"]}},{"name":"list_pull_requests","description":"List pull requests in a repository.","inputSchema":{"type":"object","properties":{"owner":{"type":"string","description":"Repository owner login"},"repo":{"type":"string","description":"Repository name"},"state":{"type":"string","description":"Pull request state: open, closed or all"}},"required":["owner","repo"]}},{"name":"get_pull_request","description":"Get one pull request by number.","inputSchema":{"type":"object","properties":{"owner":{"type":"string","description":"Repository owner login"},"repo":{"type":"string","description":"Repository name"},"pull_number":{"type":"integer","description":"Pull request number"}},"required":["owner","repo","pull_number"]}}]}`

var toolRequired = map[string][]string{
	"create_repo":        {"name"},
	"get_repo":           {"owner", "repo"},
	"create_issue":       {"owner", "repo", "title"},
	"list_issues":        {"owner", "repo"},
	"create_pull_request": {"owner", "repo", "title", "head", "base"},
	"merge_pull_request": {"owner", "repo", "pull_number"},
	"get_issue":          {"owner", "repo", "issue_number"},
	"create_comment":     {"owner", "repo", "issue_number", "body"},
	"list_pull_requests": {"owner", "repo"},
	"get_pull_request":   {"owner", "repo", "pull_number"},
}

type mcpRouter struct {
	store *Store
}

func newMcpRouter(store *Store) *mcpRouter {
	return &mcpRouter{store: store}
}

func textResult(value any) map[string]any {
	var text string
	if s, ok := value.(string); ok {
		text = s
	} else {
		text = string(marshalJSON(value))
	}
	return map[string]any{
		"content":           []any{map[string]any{"type": "text", "text": text}},
		"structuredContent": value,
	}
}

func errorResult(message string) map[string]any {
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": message}},
		"isError": true,
	}
}

func (m *mcpRouter) handle(req *httpRequest) *httpResponse {
	m.store.mu.Lock()
	defer m.store.mu.Unlock()
	if req.Method != "POST" {
		return jsonResponse(405, map[string]string{"message": "Method Not Allowed"})
	}
	auth := strings.TrimSpace(req.Headers["authorization"])
	if !strings.HasPrefix(auth, "Bearer ") || strings.TrimSpace(auth[len("Bearer "):]) == "" {
		return jsonResponse(401, map[string]string{"message": "Requires authentication"})
	}
	var parsed any
	if err := json.Unmarshal(req.Body, &parsed); err != nil {
		return jsonResponse(400, map[string]any{
			"jsonrpc": "2.0", "id": nil,
			"error": map[string]any{"code": -32700, "message": "Parse error"},
		})
	}
	msg, ok := parsed.(map[string]any)
	if !ok {
		return jsonResponse(400, map[string]any{
			"jsonrpc": "2.0", "id": nil,
			"error": map[string]any{"code": -32600, "message": "Invalid Request"},
		})
	}
	method, _ := msg["method"].(string)
	id, hasID := msg["id"]
	// Notifications get no JSON-RPC response (202, empty).
	if strings.HasPrefix(method, "notifications/") || !hasID {
		return &httpResponse{Status: 202, Headers: map[string]string{}, Body: []byte{}}
	}
	params := map[string]any{}
	if p, ok := msg["params"].(map[string]any); ok {
		params = p
	}
	switch method {
	case "server/discover":
		result := map[string]any{
			"supportedVersions": supportedVersions,
			"protocolVersion":   "2026-07-28",
			"serverInfo":        map[string]any{"name": serverName, "version": serverVersion},
			"capabilities":      map[string]any{"tools": map[string]any{}},
		}
		return m.rpc(id, result, map[string]string{"mcp-session-id": sessionID})
	case "initialize":
		requested, _ := params["protocolVersion"].(string)
		version := "2026-07-28"
		for _, v := range supportedVersions {
			if v == requested {
				version = requested
				break
			}
		}
		result := map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": serverName, "version": serverVersion},
		}
		return m.rpc(id, result, map[string]string{"mcp-session-id": sessionID})
	case "ping":
		return m.rpc(id, map[string]any{})
	case "tools/list":
		return m.rpcRaw(id, toolsListJSON)
	case "tools/call":
		name, _ := params["name"].(string)
		args := map[string]any{}
		if a, ok := params["arguments"].(map[string]any); ok {
			args = a
		}
		if _, ok := toolRequired[strings.ToLower(name)]; !ok {
			return m.rpcError(id, -32601, "Unknown tool: "+name)
		}
		result := m.callTool(name, args)
		return m.rpc(id, result)
	default:
		return m.rpcError(id, -32601, "Method not found: "+method)
	}
}

func (m *mcpRouter) rpc(id any, result any, extra ...map[string]string) *httpResponse {
	return jsonResponse(200, map[string]any{"jsonrpc": "2.0", "id": id, "result": result}, extra...)
}

func (m *mcpRouter) rpcRaw(id any, resultJSON string) *httpResponse {
	// The envelope is re-built from the precomputed tools JSON, so the bytes
	// are identical on every call.
	body := `{"jsonrpc":"2.0","id":` + string(marshalJSON(id)) + `,"result":` + resultJSON + `}`
	return &httpResponse{Status: 200, Headers: map[string]string{"content-type": "application/json"}, Body: []byte(body)}
}

func (m *mcpRouter) rpcError(id any, code int, message string) *httpResponse {
	return jsonResponse(200, map[string]any{
		"jsonrpc": "2.0", "id": id,
		"error": map[string]any{"code": code, "message": message},
	})
}

func (m *mcpRouter) callTool(name string, args map[string]any) map[string]any {
	// Tool names match case-insensitively.
	lower := strings.ToLower(name)
	var canonical string
	for k := range toolRequired {
		if k == lower {
			canonical = k
			break
		}
	}
	if canonical == "" {
		return errorResult("Unknown tool: " + name)
	}
	var missing []string
	for _, key := range toolRequired[canonical] {
		v := args[key]
		if v == nil {
			missing = append(missing, key)
			continue
		}
		if s, ok := v.(string); ok && s == "" {
			missing = append(missing, key)
		}
	}
	if len(missing) > 0 {
		return errorResult("Missing required argument(s): " + strings.Join(missing, ", "))
	}
	switch canonical {
	case "create_repo":
		return m.createRepo(args)
	case "get_repo":
		return m.getRepo(args)
	case "create_issue":
		return m.createIssue(args)
	case "list_issues":
		return m.listIssues(args)
	case "create_pull_request":
		return m.createPullRequest(args)
	case "merge_pull_request":
		return m.mergePullRequest(args)
	case "get_issue":
		return m.getIssue(args)
	case "create_comment":
		return m.createComment(args)
	case "list_pull_requests":
		return m.listPullRequests(args)
	case "get_pull_request":
		return m.getPullRequest(args)
	}
	return errorResult("Unknown tool: " + name)
}

func (m *mcpRouter) repoOf(args map[string]any) *Repo {
	owner, _ := args["owner"].(string)
	repoName, _ := args["repo"].(string)
	if (owner == "" || repoName == "") {
		if full, ok := args["repo_full_name"].(string); ok {
			parts := strings.Split(full, "/")
			if len(parts) == 2 {
				owner, repoName = parts[0], parts[1]
			}
		}
	}
	if owner == "" || repoName == "" {
		return nil
	}
	return m.store.getRepo(owner, repoName)
}

func mcpRepoJSON(repo *Repo) map[string]any {
	return map[string]any{
		"id": repoNodeID(repo), "databaseId": repo.ID, "name": repo.Name,
		"full_name": repo.Owner + "/" + repo.Name,
		"owner":         map[string]any{"login": repo.Owner},
		"private":       repo.IsPrivate,
		"description":   repo.Description,
		"default_branch": repo.DefaultBranch,
		"created_at":    repo.CreatedAt,
		"updatedAt":     repo.UpdatedAt,
	}
}

func mcpIssueJSON(repo *Repo, issue *Issue) map[string]any {
	labels := make([]any, 0, len(issue.Labels))
	for _, l := range issue.Labels {
		labels = append(labels, map[string]any{"name": l.Name, "color": l.Color, "description": l.Description})
	}
	return map[string]any{
		"id": issueNodeID(repo, issue), "databaseId": issue.ID, "number": issue.Number,
		"title": issue.Title, "body": issue.Body, "state": issue.State,
		"labels": labels,
		"user":       map[string]any{"login": issue.UserLogin},
		"created_at": issue.CreatedAt,
		"updated_at": issue.UpdatedAt,
		"closed_at":  issue.ClosedAt,
		"comments":   len(issue.Comments),
	}
}

func mcpPullJSON(repo *Repo, pull *Pull) map[string]any {
	state := pull.State
	if pull.Merged {
		state = "MERGED"
	} else if pull.State == "open" {
		state = "OPEN"
	} else {
		state = "CLOSED"
	}
	return map[string]any{
		"id": pullNodeID(repo, pull), "databaseId": pull.ID, "number": pull.Number,
		"title": pull.Title, "body": pull.Body, "state": state,
		"head": map[string]any{"ref": pull.HeadRef, "sha": pull.HeadSha},
		"base": map[string]any{"ref": pull.BaseRef, "sha": pull.BaseSha},
		"headRefName": pull.HeadRef, "baseRefName": pull.BaseRef,
		"merged": pull.Merged, "mergeable": pull.Mergeable,
		"merge_commit_sha": pull.MergeCommitSha,
		"merged_at":       pull.MergedAt,
		"user":            map[string]any{"login": pull.UserLogin},
		"created_at":      pull.CreatedAt,
		"updated_at":      pull.UpdatedAt,
	}
}

func (m *mcpRouter) createRepo(args map[string]any) map[string]any {
	name, _ := args["name"].(string)
	if m.store.getRepo(viewerLogin, name) != nil {
		return errorResult("Repository already exists")
	}
	private, _ := args["private"].(bool)
	description, _ := args["description"].(string)
	repo := m.store.createRepo(viewerLogin, name, private, description, "main")
	return textResult(mcpRepoJSON(repo))
}

func (m *mcpRouter) getRepo(args map[string]any) map[string]any {
	repo := m.repoOf(args)
	if repo == nil {
		return errorResult("Repository not found")
	}
	return textResult(mcpRepoJSON(repo))
}

func (m *mcpRouter) createIssue(args map[string]any) map[string]any {
	repo := m.repoOf(args)
	if repo == nil {
		return errorResult("Repository not found")
	}
	title, _ := args["title"].(string)
	var labels []*Label
	if arr, ok := args["labels"].([]any); ok {
		for _, l := range arr {
			var name string
			if s, ok := l.(string); ok {
				name = s
			} else if mm, ok := l.(map[string]any); ok {
				name, _ = mm["name"].(string)
			}
			label, ok := repo.Labels[name]
			if !ok {
				return errorResult("Label does not exist: " + name)
			}
			labels = append(labels, label)
		}
	}
	repo.IssueCounter++
	issue := &Issue{
		ID:        m.store.nextGlobalID(),
		Number:    repo.IssueCounter,
		Title:     title,
		Body:      stringArg(args, "body"),
		State:     "open",
		Labels:    labels,
		UserLogin: viewerLogin,
		CreatedAt: repo.CreatedAt,
		UpdatedAt: repo.UpdatedAt,
		ClosedAt:  nil,
		Comments:  []*Comment{},
		JSONCache: "",
	}
	repo.Issues[issue.Number] = issue
	return textResult(mcpIssueJSON(repo, issue))
}

func stringArg(args map[string]any, key string) string {
	if s, ok := args[key].(string); ok {
		return s
	}
	return ""
}

func (m *mcpRouter) listIssues(args map[string]any) map[string]any {
	repo := m.repoOf(args)
	if repo == nil {
		return errorResult("Repository not found")
	}
	state := stringArg(args, "state")
	if state == "" {
		state = "open"
	}
	var list []*Issue
	for _, i := range repo.Issues {
		if state != "all" && i.State != state {
			continue
		}
		list = append(list, i)
	}
	sortIssuesDesc(list)
	out := make([]any, 0, len(list))
	for _, i := range list {
		out = append(out, mcpIssueJSON(repo, i))
	}
	return textResult(out)
}

func sortIssuesDesc(list []*Issue) {
	for i := 0; i < len(list); i++ {
		for j := i + 1; j < len(list); j++ {
			if list[j].Number > list[i].Number {
				list[i], list[j] = list[j], list[i]
			}
		}
	}
}

func (m *mcpRouter) createPullRequest(args map[string]any) map[string]any {
	repo := m.repoOf(args)
	if repo == nil {
		return errorResult("Repository not found")
	}
	headName := stringArg(args, "head")
	baseName := stringArg(args, "base")
	headSha, okH := repo.Refs["refs/heads/"+headName]
	baseSha, okB := repo.Refs["refs/heads/"+baseName]
	if !okH || !okB {
		return errorResult("head or base branch does not exist")
	}
	repo.PullCounter++
	pull := &Pull{
		ID:        m.store.nextGlobalID(),
		Number:    repo.PullCounter,
		Title:     stringArg(args, "title"),
		Body:      stringArg(args, "body"),
		State:     "open",
		HeadRef:   headName,
		BaseRef:   baseName,
		HeadSha:   headSha,
		BaseSha:   baseSha,
		Merged:    false,
		Mergeable: true,
		UserLogin: viewerLogin,
		CreatedAt: repo.CreatedAt,
		UpdatedAt: repo.UpdatedAt,
	}
	repo.Pulls[pull.Number] = pull
	return textResult(mcpPullJSON(repo, pull))
}

func (m *mcpRouter) mergePullRequest(args map[string]any) map[string]any {
	repo := m.repoOf(args)
	if repo == nil {
		return errorResult("Repository not found")
	}
	num := intArg(args, "pull_number")
	pull := repo.Pulls[num]
	if pull == nil {
		return errorResult("Pull request not found")
	}
	if pull.State != "open" || pull.Merged {
		return errorResult("Pull request is not open")
	}
	baseTip, okB := repo.Refs["refs/heads/"+pull.BaseRef]
	headTip, okH := repo.Refs["refs/heads/"+pull.HeadRef]
	if !okB || !okH {
		return errorResult("head or base branch is missing")
	}
	baseCommit := parseCommit(getObject(repo, baseTip).dataOrEmpty())
	headCommit := parseCommit(getObject(repo, headTip).dataOrEmpty())
	base := mergeBase(repo, baseTip, headTip)
	var mergeBaseTree *string
	if base != "" {
		t := parseCommit(getObject(repo, base).dataOrEmpty()).Tree
		mergeBaseTree = &t
	}
	bFiles := make(map[string]string)
	hFiles := make(map[string]string)
	tFiles := make(map[string]string)
	flattenTree(repo, mergeBaseTree, "", bFiles)
	flattenTree(repo, &headCommit.Tree, "", hFiles)
	flattenTree(repo, &baseCommit.Tree, "", tFiles)
	paths := make(map[string]bool)
	for p := range bFiles {
		paths[p] = true
	}
	for p := range hFiles {
		paths[p] = true
	}
	for p := range tFiles {
		paths[p] = true
	}
	for p := range paths {
		b, h, t := bFiles[p], hFiles[p], tFiles[p]
		if h != b && t != b && h != t {
			return errorResult("Merge conflict")
		}
	}
	ident := viewerName + " <" + viewerEmail + "> " + itoa(fixedEpoch) + " +0000"
	message := "Merge pull request #" + itoa(pull.Number) + ": " + pull.Title
	mergeSha := putObject(repo, "commit", serializeCommit(headCommit.Tree, []string{baseTip}, ident, ident, message))
	repo.Refs["refs/heads/"+pull.BaseRef] = mergeSha
	pull.State = "closed"
	pull.Merged = true
	pull.MergeCommitSha = &mergeSha
	mergedAt := fixedISO
	pull.MergedAt = &mergedAt
	pull.UpdatedAt = fixedISO
	pull.BaseSha = mergeSha
	m.store.touchRefs(repo)
	merged := map[string]any{"sha": mergeSha, "merged": true, "message": message}
	for k, v := range mcpPullJSON(repo, pull) {
		merged[k] = v
	}
	return textResult(merged)
}

func intArg(args map[string]any, key string) int {
	if v, ok := args[key]; ok {
		switch n := v.(type) {
		case float64:
			return int(n)
		case int:
			return n
		case string:
			if parsed, err := atoiStrict(n); err == nil {
				return parsed
			}
		}
	}
	return 0
}

func (m *mcpRouter) getIssue(args map[string]any) map[string]any {
	repo := m.repoOf(args)
	if repo == nil {
		return errorResult("Repository not found")
	}
	num := intArg(args, "issue_number")
	issue := repo.Issues[num]
	if issue == nil {
		return errorResult("Issue not found")
	}
	return textResult(mcpIssueJSON(repo, issue))
}

func (m *mcpRouter) createComment(args map[string]any) map[string]any {
	repo := m.repoOf(args)
	if repo == nil {
		return errorResult("Repository not found")
	}
	num := intArg(args, "issue_number")
	issue := repo.Issues[num]
	if issue == nil {
		return errorResult("Issue not found")
	}
	comment := &Comment{
		ID:        m.store.nextGlobalID(),
		Body:      stringArg(args, "body"),
		UserLogin: viewerLogin,
		CreatedAt: repo.CreatedAt,
		UpdatedAt: repo.UpdatedAt,
	}
	issue.Comments = append(issue.Comments, comment)
	return textResult(map[string]any{
		"id": comment.ID, "body": comment.Body,
		"user":       map[string]any{"login": comment.UserLogin},
		"created_at": comment.CreatedAt,
		"updated_at": comment.UpdatedAt,
	})
}

func (m *mcpRouter) listPullRequests(args map[string]any) map[string]any {
	repo := m.repoOf(args)
	if repo == nil {
		return errorResult("Repository not found")
	}
	state := stringArg(args, "state")
	if state == "" {
		state = "open"
	}
	var list []*Pull
	for _, p := range repo.Pulls {
		if state != "all" && p.State != state {
			continue
		}
		list = append(list, p)
	}
	for i := 0; i < len(list); i++ {
		for j := i + 1; j < len(list); j++ {
			if list[j].Number > list[i].Number {
				list[i], list[j] = list[j], list[i]
			}
		}
	}
	out := make([]any, 0, len(list))
	for _, p := range list {
		out = append(out, mcpPullJSON(repo, p))
	}
	return textResult(out)
}

func (m *mcpRouter) getPullRequest(args map[string]any) map[string]any {
	repo := m.repoOf(args)
	if repo == nil {
		return errorResult("Repository not found")
	}
	num := intArg(args, "pull_number")
	pull := repo.Pulls[num]
	if pull == nil {
		return errorResult("Pull request not found")
	}
	return textResult(mcpPullJSON(repo, pull))
}
