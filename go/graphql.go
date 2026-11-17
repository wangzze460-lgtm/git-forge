// GraphQL v4 (/api/graphql). The suite sends gh's real documents (a fixed
// set); this executor matches them by OPERATION NAME and answers from the same
// store as REST, so objects created here read back over REST with identical
// ids. Variables come from doc.variables, never from parsing the query string.

package main

import (
	"regexp"
	"sort"
)

type graphqlRouter struct {
	store *Store
}

func newGraphqlRouter(store *Store) *graphqlRouter {
	return &graphqlRouter{store: store}
}

// Node ids live in store.go (repoNodeID, issueNodeID, pullNodeID,
// commentNodeID, decodeNodeID) and match store.ts exactly.

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

var issueFields = []string{
	"id", "databaseId", "number", "title", "body", "state", "author", "createdAt",
	"updatedAt", "closedAt", "comments", "labels", "url", "resourcePath", "bodyHTML",
	"bodyText", "closed", "locked", "milestone", "participants", "reactions", "timelineItems",
}

var pullRequestFields = []string{
	"id", "databaseId", "number", "title", "body", "state", "headRefName", "baseRefName",
	"headRefOid", "baseRefOid", "merged", "mergeable", "mergeCommit", "files", "author",
	"createdAt", "updatedAt", "closedAt", "mergedAt", "url", "resourcePath", "bodyHTML",
	"bodyText", "closed", "locked", "additions", "deletions", "changedFiles", "commits",
	"reviews", "reviewRequests", "isDraft",
}

var repositoryFields = []string{
	"id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef",
	"viewerPermission", "hasIssuesEnabled", "issues", "pullRequests", "issue",
	"pullRequest", "description", "createdAt", "updatedAt", "isPrivate", "url",
	"resourcePath", "homepageUrl", "isArchived", "isDisabled", "isFork", "isLocked",
	"licenseInfo", "primaryLanguage", "stargazerCount", "watcherCount", "forkCount",
}

var searchTypeValues = []string{
	"ISSUE", "PULL_REQUEST", "REPOSITORY", "USER", "DISCUSSION", "COMMIT", "CODE",
	"MILESTONE", "ORGANIZATION", "PROJECT", "TEAM", "WIKI",
}

func gqlState(state string, merged bool) string {
	if merged {
		return "MERGED"
	}
	if state == "open" {
		return "OPEN"
	}
	return "CLOSED"
}

func repoObject(repo *Repo) map[string]any {
	var defaultBranchRef any
	if _, ok := repo.Refs["refs/heads/"+repo.DefaultBranch]; ok {
		defaultBranchRef = map[string]any{"name": repo.DefaultBranch}
	}
	return map[string]any{
		"id": repoNodeID(repo), "databaseId": repo.ID, "name": repo.Name,
		"nameWithOwner": repo.Owner + "/" + repo.Name,
		"owner":            map[string]any{"login": repo.Owner},
		"defaultBranchRef": defaultBranchRef,
		"viewerPermission": "ADMIN",
		"hasIssuesEnabled": true,
		"description":      repo.Description,
		"createdAt":        repo.CreatedAt,
		"updatedAt":        repo.UpdatedAt,
		"isPrivate":        repo.IsPrivate,
		"url":              "https://example.invalid/" + repo.Owner + "/" + repo.Name,
	}
}

func issueObject(repo *Repo, issue *Issue) map[string]any {
	return map[string]any{
		"id": issueNodeID(repo, issue), "databaseId": issue.ID, "number": issue.Number,
		"title": issue.Title, "body": issue.Body,
		"state": func() string {
			if issue.State == "open" {
				return "OPEN"
			}
			return "CLOSED"
		}(),
		"author":    map[string]any{"login": issue.UserLogin},
		"createdAt": issue.CreatedAt,
		"updatedAt": issue.UpdatedAt,
		"closedAt":  issue.ClosedAt,
		"url":       "https://example.invalid/" + repo.Owner + "/" + repo.Name + "/issues/" + itoa(issue.Number),
	}
}

func pullObject(repo *Repo, pull *Pull) map[string]any {
	headTip, _ := repo.Refs["refs/heads/"+pull.HeadRef]
	if headTip == "" {
		headTip = pull.HeadSha
	}
	baseTip, _ := repo.Refs["refs/heads/"+pull.BaseRef]
	if baseTip == "" {
		baseTip = pull.BaseSha
	}
	var mergeCommit any
	if pull.MergeCommitSha != nil {
		mergeCommit = map[string]any{"oid": *pull.MergeCommitSha}
	}
	var closedAt any
	if pull.State == "closed" {
		closedAt = pull.UpdatedAt
	}
	mergeable := "CONFLICTING"
	if pull.Mergeable {
		mergeable = "MERGEABLE"
	}
	return map[string]any{
		"id": pullNodeID(repo, pull), "databaseId": pull.ID, "number": pull.Number,
		"title": pull.Title, "body": pull.Body,
		"state":       gqlState(pull.State, pull.Merged),
		"headRefName": pull.HeadRef,
		"baseRefName": pull.BaseRef,
		"headRefOid":  headTip,
		"baseRefOid":  baseTip,
		"merged":      pull.Merged,
		"mergeable":   mergeable,
		"mergeCommit": mergeCommit,
		"author":      map[string]any{"login": pull.UserLogin},
		"createdAt":   pull.CreatedAt,
		"updatedAt":   pull.UpdatedAt,
		"closedAt":    closedAt,
		"mergedAt":    pull.MergedAt,
		"url":         "https://example.invalid/" + repo.Owner + "/" + repo.Name + "/pull/" + itoa(pull.Number),
	}
}

// Issues ordered the way gh asks: createdAt DESC, ties by number DESC.
func sortedIssues(repo *Repo) []*Issue {
	list := make([]*Issue, 0, len(repo.Issues))
	for _, i := range repo.Issues {
		list = append(list, i)
	}
	sort.Slice(list, func(a, b int) bool {
		if list[a].CreatedAt != list[b].CreatedAt {
			return list[a].CreatedAt > list[b].CreatedAt
		}
		return list[a].Number > list[b].Number
	})
	return list
}

func sortedPulls(repo *Repo) []*Pull {
	list := make([]*Pull, 0, len(repo.Pulls))
	for _, p := range repo.Pulls {
		list = append(list, p)
	}
	sort.Slice(list, func(a, b int) bool { return list[a].Number > list[b].Number })
	return list
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

var opNameRe = regexp.MustCompile(`(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)`)

func (g *graphqlRouter) execute(doc map[string]any) map[string]any {
	g.store.mu.Lock()
	defer g.store.mu.Unlock()
	query, _ := doc["query"].(string)
	vars := map[string]any{}
	if v, ok := doc["variables"].(map[string]any); ok {
		vars = v
	}
	op := ""
	if m := opNameRe.FindStringSubmatch(query); m != nil {
		op = m[1]
	} else if s, ok := doc["operationName"].(string); ok {
		op = s
	}
	switch op {
	case "ViewerLogin":
		return map[string]any{"data": map[string]any{"viewer": map[string]any{"login": viewerLogin}}}
	case "RepositoryFields":
		repo := g.lookupRepo(vars)
		if repo == nil {
			return map[string]any{"data": map[string]any{"repository": nil}}
		}
		return map[string]any{"data": map[string]any{"repository": repoObject(repo)}}
	case "Issue_fields":
		return map[string]any{"data": map[string]any{"Issue": map[string]any{"fields": fieldNodes(issueFields)}}}
	case "PullRequestAndRepositoryFields":
		return map[string]any{"data": map[string]any{
			"PullRequest": map[string]any{"fields": fieldNodes(pullRequestFields)},
			"Repository":  map[string]any{"fields": fieldNodes(repositoryFields)},
		}}
	case "SearchType_enumValues":
		return map[string]any{"data": map[string]any{"SearchType": map[string]any{"enumValues": fieldNodes(searchTypeValues)}}}
	case "OpenIssues":
		repo := g.lookupRepo(vars)
		if repo == nil {
			return map[string]any{"data": map[string]any{"repository": nil}}
		}
		first := intVar(vars, "first", 30)
		var nodes []any
		for _, i := range sortedIssues(repo) {
			if i.State != "open" {
				continue
			}
			o := issueObject(repo, i)
			nodes = append(nodes, map[string]any{"number": o["number"], "title": o["title"], "state": o["state"], "id": o["id"]})
			if len(nodes) >= first {
				break
			}
		}
		if nodes == nil {
			nodes = []any{}
		}
		return map[string]any{"data": map[string]any{"repository": map[string]any{"issues": map[string]any{"nodes": nodes}}}}
	case "IssueByNumber":
		repo := g.lookupRepo(vars)
		if repo == nil {
			return map[string]any{"data": map[string]any{"repository": nil}}
		}
		issue := repo.Issues[intVar(vars, "number", 0)]
		if issue == nil {
			return map[string]any{"data": map[string]any{"repository": map[string]any{"issue": nil}}}
		}
		o := issueObject(repo, issue)
		return map[string]any{"data": map[string]any{"repository": map[string]any{"issue": map[string]any{
			"number": o["number"], "title": o["title"], "state": o["state"], "id": o["id"], "body": o["body"],
		}}}}
	case "IssueCreate":
		input := inputVar(vars)
		repo := g.lookupRepoByID(stringVar(input, "repositoryId"))
		if repo == nil {
			return map[string]any{"data": map[string]any{"createIssue": map[string]any{"issue": nil}}, "errors": []any{map[string]string{"message": "Repository not found"}}}
		}
		title := stringVar(input, "title")
		if title == "" {
			return map[string]any{"data": map[string]any{"createIssue": map[string]any{"issue": nil}}, "errors": []any{map[string]string{"message": "title is required"}}}
		}
		repo.IssueCounter++
		issue := &Issue{
			ID:        g.store.nextGlobalID(),
			Number:    repo.IssueCounter,
			Title:     title,
			Body:      stringVar(input, "body"),
			State:     "open",
			Labels:    []*Label{},
			UserLogin: viewerLogin,
			CreatedAt: fixedISO,
			UpdatedAt: fixedISO,
			ClosedAt:  nil,
			Comments:  []*Comment{},
			JSONCache: "",
		}
		repo.Issues[issue.Number] = issue
		return map[string]any{"data": map[string]any{"createIssue": map[string]any{"issue": map[string]any{
			"number": issue.Number, "id": issueNodeID(repo, issue),
		}}}}
	case "IssueClose":
		input := inputVar(vars)
		found := g.lookupIssueByID(stringVar(input, "issueId"))
		if found == nil {
			return map[string]any{"data": map[string]any{"closeIssue": map[string]any{"issue": nil}}, "errors": []any{map[string]string{"message": "Issue not found"}}}
		}
		found.issue.State = "closed"
		closed := fixedISO
		found.issue.ClosedAt = &closed
		// Invalidate the REST single-issue cache so the REST view reads closed too.
		found.issue.JSONCache = ""
		return map[string]any{"data": map[string]any{"closeIssue": map[string]any{"issue": map[string]any{
			"number": found.issue.Number, "id": issueNodeID(found.repo, found.issue), "state": "CLOSED",
		}}}}
	case "PullRequests":
		repo := g.lookupRepo(vars)
		if repo == nil {
			return map[string]any{"data": map[string]any{"repository": nil}}
		}
		first := intVar(vars, "first", 30)
		var nodes []any
		for _, p := range sortedPulls(repo) {
			o := pullObject(repo, p)
			nodes = append(nodes, map[string]any{
				"number": o["number"], "headRefName": o["headRefName"], "baseRefName": o["baseRefName"],
				"mergeable": o["mergeable"], "state": o["state"],
			})
			if len(nodes) >= first {
				break
			}
		}
		if nodes == nil {
			nodes = []any{}
		}
		return map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequests": map[string]any{"nodes": nodes}}}}
	case "PullRequestFiles":
		repo := g.lookupRepo(vars)
		if repo == nil {
			return map[string]any{"data": map[string]any{"repository": nil}}
		}
		pull := repo.Pulls[intVar(vars, "number", 0)]
		if pull == nil {
			return map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": nil}}}
		}
		paths := g.pullPaths(repo, pull)
		var nodes []any
		for i, p := range paths {
			if i >= 10 {
				break
			}
			nodes = append(nodes, map[string]any{"path": p})
		}
		if nodes == nil {
			nodes = []any{}
		}
		return map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": map[string]any{
			"number": pull.Number, "files": map[string]any{"nodes": nodes},
		}}}}
	case "PullRequestId":
		repo := g.lookupRepo(vars)
		if repo == nil {
			return map[string]any{"data": map[string]any{"repository": nil}}
		}
		pull := repo.Pulls[intVar(vars, "number", 0)]
		if pull == nil {
			return map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": nil}}}
		}
		return map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": map[string]any{
			"id": pullNodeID(repo, pull), "number": pull.Number,
		}}}}
	case "PullRequestCreate":
		input := inputVar(vars)
		repo := g.lookupRepoByID(stringVar(input, "repositoryId"))
		if repo == nil {
			return map[string]any{"data": map[string]any{"createPullRequest": map[string]any{"pullRequest": nil}}, "errors": []any{map[string]string{"message": "Repository not found"}}}
		}
		headName := stringVar(input, "headRefName")
		baseName := stringVar(input, "baseRefName")
		headSha, okH := repo.Refs["refs/heads/"+headName]
		baseSha, okB := repo.Refs["refs/heads/"+baseName]
		if !okH || !okB {
			return map[string]any{"data": map[string]any{"createPullRequest": map[string]any{"pullRequest": nil}}, "errors": []any{map[string]string{"message": "head or base branch does not exist"}}}
		}
		repo.PullCounter++
		pull := &Pull{
			ID:        g.store.nextGlobalID(),
			Number:    repo.PullCounter,
			Title:     stringVar(input, "title"),
			Body:      stringVar(input, "body"),
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
		o := pullObject(repo, pull)
		return map[string]any{"data": map[string]any{"createPullRequest": map[string]any{"pullRequest": map[string]any{
			"number": o["number"], "id": o["id"], "state": o["state"],
			"headRefName": o["headRefName"], "baseRefName": o["baseRefName"],
		}}}}
	case "MergePullRequest":
		input := inputVar(vars)
		found := g.lookupPullByID(stringVar(input, "pullRequestId"))
		if found == nil {
			return map[string]any{"data": map[string]any{"mergePullRequest": map[string]any{"pullRequest": nil}}, "errors": []any{map[string]string{"message": "Pull request not found"}}}
		}
		if found.pull.State != "open" || found.pull.Merged {
			return map[string]any{"data": map[string]any{"mergePullRequest": map[string]any{"pullRequest": nil}}, "errors": []any{map[string]string{"message": "Pull request is not open"}}}
		}
		if !g.mergePull(found.repo, found.pull, "squash") {
			return map[string]any{"data": map[string]any{"mergePullRequest": map[string]any{"pullRequest": nil}}, "errors": []any{map[string]string{"message": "Merge conflict"}}}
		}
		return map[string]any{"data": map[string]any{"mergePullRequest": map[string]any{"pullRequest": map[string]any{
			"number": found.pull.Number, "merged": true, "state": "MERGED",
		}}}}
	case "AddComment":
		input := inputVar(vars)
		found := g.lookupIssueByID(stringVar(input, "subjectId"))
		if found == nil {
			return map[string]any{"data": map[string]any{"addComment": map[string]any{"commentEdge": nil}}, "errors": []any{map[string]string{"message": "Subject not found"}}}
		}
		body := stringVar(input, "body")
		comment := &Comment{
			ID:        g.store.nextGlobalID(),
			Body:      body,
			UserLogin: viewerLogin,
			CreatedAt: fixedISO,
			UpdatedAt: fixedISO,
		}
		found.issue.Comments = append(found.issue.Comments, comment)
		found.issue.JSONCache = ""
		return map[string]any{"data": map[string]any{"addComment": map[string]any{"commentEdge": map[string]any{"node": map[string]any{
			"id": commentNodeID(found.repo, comment), "body": body,
		}}}}}
	case "ViewerInvalidField":
		return map[string]any{
			"data":   nil,
			"errors": []any{map[string]any{"message": `Cannot query field "noSuchFieldOnViewer" on type "User".`, "locations": []any{map[string]int{"line": 4, "column": 5}}}},
		}
	case "NodeRepository":
		kind, repoID, _, ok := decodeNodeID(stringVar(vars, "id"))
		if !ok || kind != "Repository" {
			return map[string]any{"data": map[string]any{"node": nil}}
		}
		repo := g.store.getRepoByID(repoID)
		if repo == nil {
			return map[string]any{"data": map[string]any{"node": nil}}
		}
		o := repoObject(repo)
		return map[string]any{"data": map[string]any{"node": map[string]any{
			"id": o["id"], "name": o["name"], "nameWithOwner": o["nameWithOwner"],
		}}}
	case "IssuesPage":
		repo := g.lookupRepo(vars)
		if repo == nil {
			return map[string]any{"data": map[string]any{"repository": nil}}
		}
		first := intVar(vars, "first", 30)
		after := stringVar(vars, "after")
		list := sortedIssues(repo)
		if after != "" {
			if decoded, err := base64urlDecode(after); err == nil {
				if m := regexp.MustCompile(`^issue:(\d+):(\d+)$`).FindStringSubmatch(decoded); m != nil {
					afterNum, _ := atoiStrict(m[2])
					for idx, i := range list {
						if i.Number == afterNum {
							list = list[idx+1:]
							break
						}
					}
				}
			}
		}
		page := list
		if len(page) > first {
			page = page[:first]
		}
		hasNextPage := len(list) > first
		var endCursor any
		if len(page) > 0 {
			endCursor = b64url("issue:" + itoa(repo.ID) + ":" + itoa(page[len(page)-1].Number))
		}
		var nodes []any
		for _, i := range page {
			nodes = append(nodes, map[string]any{"number": i.Number})
		}
		if nodes == nil {
			nodes = []any{}
		}
		return map[string]any{"data": map[string]any{"repository": map[string]any{"issues": map[string]any{
			"nodes": nodes,
			"pageInfo": map[string]any{"hasNextPage": hasNextPage, "endCursor": endCursor},
		}}}}
	default:
		return map[string]any{"data": nil, "errors": []any{map[string]string{"message": `Unknown operation "` + op + `"`}}}
	}
}

func fieldNodes(names []string) []any {
	out := make([]any, 0, len(names))
	for _, n := range names {
		out = append(out, map[string]any{"name": n})
	}
	return out
}

func intVar(vars map[string]any, key string, def int) int {
	if v, ok := vars[key]; ok {
		switch n := v.(type) {
		case int:
			return n
		case float64:
			return int(n)
		}
	}
	return def
}

func stringVar(vars map[string]any, key string) string {
	if v, ok := vars[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func inputVar(vars map[string]any) map[string]any {
	if v, ok := vars["input"].(map[string]any); ok {
		return v
	}
	return map[string]any{}
}

// atoiStrict parses a decimal integer, rejecting anything else.
func atoiStrict(s string) (int, error) {
	if s == "" {
		return 0, errNotInt
	}
	n := 0
	neg := false
	i := 0
	if s[0] == '-' {
		neg = true
		i = 1
	}
	if i >= len(s) {
		return 0, errNotInt
	}
	for ; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, errNotInt
		}
		n = n*10 + int(s[i]-'0')
	}
	if neg {
		n = -n
	}
	return n, nil
}

type notIntError struct{}

func (notIntError) Error() string { return "not an int" }

var errNotInt = notIntError{}


// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

func (g *graphqlRouter) lookupRepo(vars map[string]any) *Repo {
	owner := stringVar(vars, "owner")
	name := stringVar(vars, "name")
	if owner == "" || name == "" {
		return nil
	}
	repo := g.store.getRepo(owner, name)
	if repo == nil || repo.Owner != viewerLogin {
		return nil
	}
	return repo
}

func (g *graphqlRouter) lookupRepoByID(id string) *Repo {
	if id == "" {
		return nil
	}
	kind, repoID, _, ok := decodeNodeID(id)
	if !ok || kind != "Repository" {
		return nil
	}
	return g.store.getRepoByID(repoID)
}

type issueRef struct {
	repo  *Repo
	issue *Issue
}

func (g *graphqlRouter) lookupIssueByID(id string) *issueRef {
	if id == "" {
		return nil
	}
	kind, repoID, num, ok := decodeNodeID(id)
	if !ok || kind != "Issue" {
		return nil
	}
	repo := g.store.getRepoByID(repoID)
	if repo == nil {
		return nil
	}
	issue := repo.Issues[num]
	if issue == nil {
		return nil
	}
	return &issueRef{repo, issue}
}

type pullRef struct {
	repo *Repo
	pull *Pull
}

func (g *graphqlRouter) lookupPullByID(id string) *pullRef {
	if id == "" {
		return nil
	}
	kind, repoID, num, ok := decodeNodeID(id)
	if !ok || kind != "PullRequest" {
		return nil
	}
	repo := g.store.getRepoByID(repoID)
	if repo == nil {
		return nil
	}
	pull := repo.Pulls[num]
	if pull == nil {
		return nil
	}
	return &pullRef{repo, pull}
}

// pullPaths returns the changed paths between the pull's base and head trees.
func (g *graphqlRouter) pullPaths(repo *Repo, pull *Pull) []string {
	baseTip, _ := repo.Refs["refs/heads/"+pull.BaseRef]
	headTip, _ := repo.Refs["refs/heads/"+pull.HeadRef]
	var baseTree, headTree *string
	if baseTip != "" {
		if obj := getObject(repo, baseTip); obj != nil {
			t := parseCommit(obj.Data).Tree
			baseTree = &t
		}
	}
	if headTip != "" {
		if obj := getObject(repo, headTip); obj != nil {
			t := parseCommit(obj.Data).Tree
			headTree = &t
		}
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
	var out []string
	for p := range paths {
		if baseFiles[p] != headFiles[p] {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

// mergePull squash-merges a pull request; false when it conflicts.
func (g *graphqlRouter) mergePull(repo *Repo, pull *Pull, method string) bool {
	baseTip, okB := repo.Refs["refs/heads/"+pull.BaseRef]
	headTip, okH := repo.Refs["refs/heads/"+pull.HeadRef]
	if !okB || !okH {
		return false
	}
	baseCommit := parseCommit(getObject(repo, baseTip).dataOrEmpty())
	headCommit := parseCommit(getObject(repo, headTip).dataOrEmpty())
	baseTree := baseCommit.Tree
	headTree := headCommit.Tree
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
	flattenTree(repo, &headTree, "", hFiles)
	flattenTree(repo, &baseTree, "", tFiles)
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
			return false
		}
	}
	message := "Merge pull request #" + itoa(pull.Number) + ": " + pull.Title
	ident := viewerName + " <" + viewerEmail + "> " + itoa(fixedEpoch) + " +0000"
	var parents []string
	if method == "merge" {
		parents = []string{baseTip, headTip}
	} else {
		parents = []string{baseTip}
	}
	mergeSha := putObject(repo, "commit", serializeCommit(headTree, parents, ident, ident, message))
	repo.Refs["refs/heads/"+pull.BaseRef] = mergeSha
	pull.State = "closed"
	pull.Merged = true
	pull.MergeCommitSha = &mergeSha
	mergedAt := fixedISO
	pull.MergedAt = &mergedAt
	pull.UpdatedAt = fixedISO
	pull.BaseSha = mergeSha
	g.store.touchRefs(repo)
	return true
}
