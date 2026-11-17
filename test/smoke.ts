// Local smoke test: boots the forge on a fixed port and exercises REST/GraphQL/MCP/git.
import { createApp } from '../app.ts';

const PORT = 18099;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token';

const server = createApp();
await new Promise<void>((resolve) => server.listen(PORT, resolve));
console.log('listening on', PORT);

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name} ${detail}`);
  }
}

async function req(method: string, path: string, body?: unknown, token: string | null = TOKEN, extraHeaders: Record<string, string> = {}): Promise<{ status: number; text: string; json: unknown; headers: Headers }> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json, headers: res.headers };
}

async function reqRaw(method: string, path: string, body: Buffer, headers: Record<string, string> = {}): Promise<{ status: number; buf: Buffer; ctype: string }> {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${TOKEN}`, ...headers } };
  if (body.length > 0) init.body = body;
  const res = await fetch(`${BASE}${path}`, init);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, ctype: res.headers.get('content-type') ?? '' };
}

// --- basics
{
  const r = await req('GET', '/healthz', undefined, null);
  check('healthz', r.status === 200 && (r.json as Record<string, unknown>).ok === true, r.text);
  const root = await req('GET', '/api/v3/', undefined, null);
  check('api root', root.status === 200 && root.headers.get('x-oauth-scopes') !== null, root.text);
  const meta = await req('GET', '/api/v3/meta', undefined, null);
  check('meta', meta.status === 200 && (meta.json as Record<string, unknown>).installed_version === '1.0.0', meta.text);
  const anon = await req('GET', '/api/v3/user/repos', undefined, null);
  check('no token -> 401', anon.status === 401, String(anon.status));
  const bad = await req('GET', '/api/v3/repos/adaiversen/nope', undefined, 'wrong-token');
  check('missing repo -> 404', bad.status === 404, String(bad.status));
  const badJson = await req('POST', '/api/v3/user/repos', undefined, TOKEN, { 'content-type': 'application/json' });
  void badJson;
}

// --- repo + contents
const repoName = 'smoke-repo';
{
  const r = await req('POST', '/api/v3/user/repos', { name: repoName, private: false, description: 'smoke' });
  check('create repo 201', r.status === 201 && (r.json as Record<string, unknown>).name === repoName, r.text);
  const content = Buffer.from('hello forge\nline two\n').toString('base64');
  const put = await req('PUT', `/api/v3/repos/adaiversen/${repoName}/contents/README.md`, { message: 'first commit', content });
  check('put contents 201', put.status === 201, put.text);
  const putJson = put.json as Record<string, { sha: string }>;
  const get = await req('GET', `/api/v3/repos/adaiversen/${repoName}/contents/README.md`);
  const getJson = get.json as Record<string, unknown>;
  check('get contents', get.status === 200 && getJson.sha === putJson.content.sha && getJson.size === 21, get.text);
  const commits = await req('GET', `/api/v3/repos/adaiversen/${repoName}/commits`);
  const commitsJson = commits.json as Array<Record<string, { message: string }>>;
  check('commits list', commits.status === 200 && commitsJson.length === 1 && commitsJson[0]?.commit.message === 'first commit', commits.text);
  const branches = await req('GET', `/api/v3/repos/adaiversen/${repoName}/branches`);
  check('branches', branches.status === 200 && (branches.json as Array<Record<string, unknown>>).length === 1, branches.text);
  const headSha = commitsJson[0]?.sha as string;
  const branch = await req('POST', `/api/v3/repos/adaiversen/${repoName}/git/refs`, { ref: 'refs/heads/feature', sha: headSha });
  check('create branch 201', branch.status === 201, branch.text);
  const content2 = Buffer.from('hello forge\nline two\nline three\n').toString('base64');
  const put2 = await req('PUT', `/api/v3/repos/adaiversen/${repoName}/contents/README.md`, { message: 'second commit', content: content2, branch: 'feature' });
  check('put on branch 200 (update)', put2.status === 200, put2.text);
  const dir = await req('GET', `/api/v3/repos/adaiversen/${repoName}/contents/`);
  check('root listing', dir.status === 200 && Array.isArray(dir.json), dir.text);
}

// --- issues
let issueNumber = 0;
{
  const label = await req('POST', `/api/v3/repos/adaiversen/${repoName}/labels`, { name: 'bug', color: 'ff0000' });
  check('create label', label.status === 201, label.text);
  const badIssue = await req('POST', `/api/v3/repos/adaiversen/${repoName}/issues`, { title: 'x', labels: ['nope'] });
  check('unknown label -> 422', badIssue.status === 422, String(badIssue.status));
  const issue = await req('POST', `/api/v3/repos/adaiversen/${repoName}/issues`, { title: 'first issue', body: 'body text', labels: ['bug'] });
  check('create issue 201', issue.status === 201, issue.text);
  issueNumber = (issue.json as Record<string, number>).number;
  const list = await req('GET', `/api/v3/repos/adaiversen/${repoName}/issues?state=open&sort=created&direction=asc`);
  check('list issues', list.status === 200 && (list.json as unknown[]).length === 1, list.text);
  const one = await req('GET', `/api/v3/repos/adaiversen/${repoName}/issues/${issueNumber}`);
  check('get issue', one.status === 200 && (one.json as Record<string, unknown>).title === 'first issue', one.text);
  const comment = await req('POST', `/api/v3/repos/adaiversen/${repoName}/issues/${issueNumber}/comments`, { body: 'a comment' });
  check('comment 201', comment.status === 201, comment.text);
  const patch = await req('PATCH', `/api/v3/repos/adaiversen/${repoName}/issues/${issueNumber}`, { state: 'closed' });
  check('close issue', patch.status === 200 && (patch.json as Record<string, unknown>).state === 'closed', patch.text);
}

// --- pulls
let pullNumber = 0;
{
  const pr = await req('POST', `/api/v3/repos/adaiversen/${repoName}/pulls`, { title: 'add line three', head: 'feature', base: 'main', body: 'pr body' });
  check('create pull 201', pr.status === 201, pr.text);
  pullNumber = (pr.json as Record<string, number>).number;
  const files = await req('GET', `/api/v3/repos/adaiversen/${repoName}/pulls/${pullNumber}/files`);
  const filesJson = files.json as Array<Record<string, unknown>>;
  check('pull files', files.status === 200 && filesJson.length === 1 && filesJson[0]?.filename === 'README.md' && filesJson[0]?.status === 'modified', files.text);
  const merge = await req('PUT', `/api/v3/repos/adaiversen/${repoName}/pulls/${pullNumber}/merge`, { merge_method: 'squash' });
  check('merge squash 200', merge.status === 200 && (merge.json as Record<string, unknown>).merged === true, merge.text);
  const after = await req('GET', `/api/v3/repos/adaiversen/${repoName}/contents/README.md`);
  const afterJson = after.json as Record<string, string>;
  check('squash content on main', Buffer.from(afterJson.content, 'base64').toString('utf8').includes('line three'), after.text);
}

// --- GraphQL
{
  const gql = async (body: unknown, token: string | null = TOKEN): Promise<{ status: number; json: Record<string, unknown> }> => {
    const r = await req('POST', '/api/graphql', body, token);
    return { status: r.status, json: r.json as Record<string, unknown> };
  };
  const noAuth = await gql({ query: 'query ViewerLogin { viewer { login } }' }, null);
  check('graphql no token -> 401', noAuth.status === 401, String(noAuth.status));
  const viewer = await gql({ query: 'query ViewerLogin { viewer { login } }' });
  check('graphql viewer', (viewer.json.data as Record<string, Record<string, string>>).viewer.login === 'adaiversen', JSON.stringify(viewer.json));
  const repoQ = await gql({ query: 'query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled } }', variables: { owner: 'adaiversen', name: repoName } });
  const repoData = (repoQ.json.data as Record<string, Record<string, unknown>>).repository;
  check('graphql repository', repoData !== null && repoData.name === repoName && repoData.viewerPermission === 'ADMIN', JSON.stringify(repoQ.json));
  const missingRepo = await gql({ query: 'query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }', variables: { owner: 'adaiversen', name: 'nope' } });
  check('graphql missing repo -> null, no errors', (missingRepo.json.data as Record<string, unknown>).repository === null && missingRepo.json.errors === undefined, JSON.stringify(missingRepo.json));
  const issueFields = await gql({ query: 'query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }' });
  const fields = ((issueFields.json.data as Record<string, Record<string, Array<Record<string, string>>>>).Issue.fields ?? []).map((f) => f.name);
  check('graphql Issue fields', fields.includes('number') && fields.includes('title'), JSON.stringify(issueFields.json));
  const searchType = await gql({ query: 'query SearchType_enumValues { SearchType: __type(name: "SearchType") { enumValues(includeDeprecated: true) { name } } }' });
  const enums = ((searchType.json.data as Record<string, Record<string, Array<Record<string, string>>>>).SearchType.enumValues ?? []).map((e) => e.name);
  check('graphql SearchType has ISSUE', enums.includes('ISSUE'), JSON.stringify(searchType.json));
  const openIssues = await gql({ query: 'query OpenIssues($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number title state id } } } }', variables: { owner: 'adaiversen', name: repoName, first: 10 } });
  check('graphql open issues (closed one excluded)', ((openIssues.json.data as Record<string, Record<string, Record<string, unknown[]>>>).repository.issues.nodes ?? []).length === 0, JSON.stringify(openIssues.json));
  const repoId = repoData.id as string;
  const createIssue = await gql({ query: 'mutation IssueCreate($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id } } }', variables: { input: { repositoryId: repoId, title: 'gql issue', body: 'via graphql' } } });
  const createdIssue = (createIssue.json.data as Record<string, Record<string, Record<string, unknown>>>).createIssue.issue;
  check('graphql create issue', createdIssue !== null && typeof createdIssue.number === 'number', JSON.stringify(createIssue.json));
  const byNumber = await gql({ query: 'query IssueByNumber($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { number title state id body } } }', variables: { owner: 'adaiversen', name: repoName, number: createdIssue.number } });
  check('graphql issue by number', ((byNumber.json.data as Record<string, Record<string, Record<string, unknown>>>).repository.issue ?? {}).title === 'gql issue', JSON.stringify(byNumber.json));
  const nodeQ = await gql({ query: 'query NodeRepository($id: ID!) { node(id: $id) { id ... on Repository { name nameWithOwner } } }', variables: { id: repoId } });
  check('graphql node repository', ((nodeQ.json.data as Record<string, Record<string, unknown>>).node ?? {}).nameWithOwner === `adaiversen/${repoName}`, JSON.stringify(nodeQ.json));
  const invalid = await gql({ query: 'query ViewerInvalidField { viewer { login noSuchFieldOnViewer } }' });
  check('graphql invalid field -> 200 + errors naming it', invalid.status === 200 && JSON.stringify(invalid.json.errors ?? []).includes('noSuchFieldOnViewer'), JSON.stringify(invalid.json));
  const batch = await gql([
    { query: 'query ViewerLogin { viewer { login } }' },
    { query: 'query ViewerLogin { viewer { login } }' },
  ]);
  check('graphql batch', Array.isArray(batch.json) && batch.json.length === 2, JSON.stringify(batch.json));
  const page = await gql({ query: 'query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) { repository(owner: $owner, name: $name) { issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } } } }', variables: { owner: 'adaiversen', name: repoName, first: 1, after: null } });
  const pageInfo = (page.json.data as Record<string, Record<string, Record<string, Record<string, unknown>>>>).repository.issues.pageInfo;
  check('graphql issues page', pageInfo.hasNextPage === true && typeof pageInfo.endCursor === 'string', JSON.stringify(page.json));
}

// --- MCP
{
  const mcp = async (body: unknown, token: string | null = TOKEN, extra: Record<string, string> = {}): Promise<{ status: number; text: string; json: Record<string, unknown>; headers: Headers }> => {
    const r = await req('POST', '/mcp', body, token, extra);
    return { status: r.status, text: r.text, json: (r.json ?? {}) as Record<string, unknown>, headers: r.headers };
  };
  const noAuth = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, null);
  check('mcp no token -> 401', noAuth.status === 401, String(noAuth.status));
  const discover = await mcp({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }, TOKEN, { 'mcp-protocol-version': '2026-07-28' });
  const discResult = discover.json.result as Record<string, unknown>;
  check('mcp server/discover', Array.isArray(discResult.supportedVersions) && (discResult.supportedVersions as string[]).length > 0 && (discResult.serverInfo as Record<string, string>).name !== '', discover.text);
  const init = await mcp({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  check('mcp initialize + session id', init.status === 200 && init.headers.get('mcp-session-id') !== null, init.text);
  const notif = await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
  check('mcp notification -> 202', notif.status === 202, String(notif.status));
  const list1 = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  const list2 = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
  const tools = (list1.json.result as Record<string, Array<Record<string, unknown>>>).tools ?? [];
  const names = tools.map((t) => t.name);
  check('mcp tools/list >=6 + canonical', tools.length >= 6 && ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'].every((n) => names.includes(n)), list1.text);
  check('mcp tools/list byte-identical', JSON.stringify(list1.json.result) === JSON.stringify(list2.json.result), '');
  const createRepo = await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_repo', arguments: { name: 'mcp-repo' } } });
  const created = (createRepo.json.result as Record<string, Array<Record<string, string>>>).content?.[0]?.text ?? '';
  check('mcp create_repo', createRepo.status === 200 && created.includes('mcp-repo'), createRepo.text);
  const createIssue = await mcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'mcp-repo', title: 'mcp issue' } } });
  const issueText = (createIssue.json.result as Record<string, Array<Record<string, string>>>).content?.[0]?.text ?? '';
  check('mcp create_issue', issueText.includes('"number":1'), createIssue.text);
  const restCheck = await req('GET', '/api/v3/repos/adaiversen/mcp-repo/issues/1');
  check('mcp issue reads back over REST', restCheck.status === 200 && (restCheck.json as Record<string, unknown>).title === 'mcp issue', restCheck.text);
  const missingArg = await mcp({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'create_issue', arguments: {} } });
  const missingResult = missingArg.json.result as Record<string, unknown>;
  check('mcp missing arg -> isError', missingResult.isError === true, missingArg.text);
  const unknownTool = await mcp({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
  const unknownErr = unknownTool.json.error as Record<string, number>;
  check('mcp unknown tool -> -32601', unknownErr?.code === -32601, unknownTool.text);
  const badJson = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{not json' });
  const badJsonBody = await badJson.json() as Record<string, unknown>;
  check('mcp bad json -> 400 -32700', badJson.status === 400 && (badJsonBody.error as Record<string, number>).code === -32700, String(badJson.status));
}

// --- git smart HTTP (raw pkt-lines)
{
  const pkt = (s: string): Buffer => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0'), 'ascii'), b]);
  };
  const adv2 = await reqRaw('GET', `/${'adaiversen'}/${repoName}.git/info/refs?service=git-upload-pack`, Buffer.alloc(0), { 'git-protocol': 'version=2' });
  check('git info/refs v2', adv2.status === 200 && adv2.buf.toString('utf8').includes('version 2'), adv2.buf.toString('utf8').slice(0, 120));
  const adv0 = await reqRaw('GET', `/${'adaiversen'}/${repoName}.git/info/refs?service=git-upload-pack`, Buffer.alloc(0));
  check('git info/refs v0 preamble', adv0.status === 200 && adv0.buf.toString('utf8').includes('# service=git-upload-pack'), adv0.buf.toString('utf8').slice(0, 120));
  const missing = await reqRaw('GET', '/adaiversen/nope.git/info/refs?service=git-upload-pack', Buffer.alloc(0));
  check('git missing repo -> 404', missing.status === 404, String(missing.status));
  // v2 ls-refs
  const lsBody = Buffer.concat([pkt('command=ls-refs\n'), pkt('agent=test\n'), Buffer.from('0001', 'ascii'), pkt('peel\n'), pkt('symrefs\n'), pkt('unborn\n'), Buffer.from('0000', 'ascii')]);
  const ls = await reqRaw('POST', `/adaiversen/${repoName}.git/git-upload-pack`, lsBody, { 'git-protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request' });
  const lsText = ls.buf.toString('utf8');
  check('git v2 ls-refs', ls.status === 200 && lsText.includes('refs/heads/main') && lsText.includes('symref-target:refs/heads/main'), lsText.slice(0, 300));
  // v2 fetch (want main tip)
  const commits = await req('GET', `/api/v3/repos/adaiversen/${repoName}/commits`);
  const tip = (commits.json as Array<Record<string, string>>)[0]?.sha as string;
  const fetchBody = Buffer.concat([pkt('command=fetch\n'), pkt('agent=test\n'), Buffer.from('0001', 'ascii'), pkt('thin-pack\n'), pkt('ofs-delta\n'), pkt(`want ${tip}\n`), pkt('done\n'), Buffer.from('0000', 'ascii')]);
  const fetchRes = await reqRaw('POST', `/adaiversen/${repoName}.git/git-upload-pack`, fetchBody, { 'git-protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request' });
  check('git v2 fetch packfile', fetchRes.status === 200 && fetchRes.buf.includes(Buffer.from('PACK')), `status=${fetchRes.status} len=${fetchRes.buf.length}`);
  // v0 fetch
  const fetch0Body = Buffer.concat([pkt(`want ${tip} side-band-64k\n`), Buffer.from('0000', 'ascii'), pkt('done\n'), Buffer.from('0000', 'ascii')]);
  const fetch0 = await reqRaw('POST', `/adaiversen/${repoName}.git/git-upload-pack`, fetch0Body, { 'content-type': 'application/x-git-upload-pack-request' });
  check('git v0 fetch packfile', fetch0.status === 200 && fetch0.buf.includes(Buffer.from('PACK')), `status=${fetch0.status} len=${fetch0.buf.length}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
server.close();
process.exit(failed > 0 ? 1 : 0);
