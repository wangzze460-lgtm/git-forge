// In-memory store for the forge. Everything lives in maps; nothing touches disk.
// Determinism: every timestamp the store emits comes from a fixed instant (the
// trial's MAKEFUN_TRIAL_NOW when set, else a constant), never from the wall
// clock, so two runs of the same trial leave identical state.
//
// Concurrency: the server is concurrent (50 simultaneous clones). One RWMutex
// guards the whole store; reads take the read lock, mutations the write lock.
// The hot read path (single-issue GET) therefore never blocks on another reader.

package main

import (
	"encoding/base64"
	"os"
	"strings"
	"sync"
)

const viewerLogin = "adaiversen"
const viewerID = 1000
const viewerName = "ada iversen"
const viewerEmail = "adaiversen@example.invalid"

var fixedISO = func() string {
	if v := strings.TrimSpace(os.Getenv("MAKEFUN_TRIAL_NOW")); v != "" {
		return v
	}
	return "2026-11-14T06:30:00.000Z"
}()

// Fixed epoch seconds stamped into every server-created git object.
const fixedEpoch = 1700000000

type Label struct {
	Name        string
	Color       string
	Description string
}

type Issue struct {
	ID        int
	Number    int
	Title     string
	Body      string
	State     string // "open" | "closed"
	Labels    []*Label
	UserLogin string
	CreatedAt string
	UpdatedAt string
	ClosedAt  *string
	Comments  []*Comment
	// Pre-rendered JSON for the single-issue GET hot path.
	JSONCache string
}

type Comment struct {
	ID        int
	Body      string
	UserLogin string
	CreatedAt string
	UpdatedAt string
}

type Pull struct {
	ID            int
	Number        int
	Title         string
	Body          string
	State         string // "open" | "closed"
	HeadRef       string
	BaseRef       string
	HeadSha       string
	BaseSha       string
	Merged        bool
	Mergeable     bool
	MergeCommitSha *string
	MergedAt      *string
	UserLogin     string
	CreatedAt     string
	UpdatedAt     string
}

type GitObject struct {
	Type string // "blob" | "tree" | "commit" | "tag"
	Data []byte
	// The validated deflated bytes this object arrived as (from a pack ingest).
	// Reusing them in buildPack skips a deflate per object; absent for objects
	// built locally or resolved from a delta.
	Deflated []byte
}

type packEntry struct {
	Pack     []byte
	Shallow  []string
	Unshallow []string
}

type Repo struct {
	ID           int
	Name         string
	Owner        string
	Description  string
	IsPrivate    bool
	DefaultBranch string
	CreatedAt    string
	UpdatedAt    string
	IssueCounter int
	PullCounter  int
	CommentCounter int
	Issues       map[int]*Issue
	Pulls        map[int]*Pull
	Labels       map[string]*Label
	// refname -> sha
	Refs map[string]string
	// sha -> object
	Objects map[string]*GitObject
	// Cache: fetch results by key (want set + depth + haves + shallow boundary).
	PackCache map[string]*packEntry
	// Cache: whole fetch response bytes by the same key.
	FetchCache map[string][]byte
	// Cache: ls-refs responses by ref-version + options.
	LsRefsCache map[string][]byte
	// Cache: advertisement lines by ref-version.
	AdvCache   []byte
	AdvVersion int
}

type Store struct {
	mu        sync.RWMutex
	repos     map[string]*Repo // key: owner + "/" + name
	reposByID map[int]*Repo
	repoIDCounter   int
	globalIDCounter int
}

func NewStore() *Store {
	return &Store{
		repos:           make(map[string]*Repo),
		reposByID:       make(map[int]*Repo),
		repoIDCounter:   5000,
		globalIDCounter: 100000,
	}
}

func repoKey(owner, name string) string { return owner + "/" + name }

// getRepo reads without locking; callers must hold at least the read lock.
func (s *Store) getRepo(owner, name string) *Repo {
	return s.repos[repoKey(owner, name)]
}

func (s *Store) getRepoByID(id int) *Repo { return s.reposByID[id] }

// createRepo writes; callers must hold the write lock.
func (s *Store) createRepo(owner, name string, isPrivate bool, description, defaultBranch string) *Repo {
	repo := &Repo{
		ID:            s.repoIDCounter,
		Name:          name,
		Owner:         owner,
		Description:   description,
		IsPrivate:     isPrivate,
		DefaultBranch: defaultBranch,
		CreatedAt:     fixedISO,
		UpdatedAt:     fixedISO,
		Issues:        make(map[int]*Issue),
		Pulls:         make(map[int]*Pull),
		Labels:        make(map[string]*Label),
		Refs:          make(map[string]string),
		Objects:       make(map[string]*GitObject),
		PackCache:     make(map[string]*packEntry),
		FetchCache:    make(map[string][]byte),
		LsRefsCache:   make(map[string][]byte),
	}
	s.repoIDCounter++
	s.repos[repoKey(owner, name)] = repo
	s.reposByID[repo.ID] = repo
	return repo
}

// deleteRepo writes; callers must hold the write lock.
func (s *Store) deleteRepo(owner, name string) bool {
	repo := s.getRepo(owner, name)
	if repo == nil {
		return false
	}
	delete(s.repos, repoKey(owner, name))
	delete(s.reposByID, repo.ID)
	return true
}

func (s *Store) nextGlobalID() int {
	id := s.globalIDCounter
	s.globalIDCounter++
	return id
}

// touchRefs bumps a repo's ref version: drops cached advertisements and packs.
// Callers must hold the write lock.
func (s *Store) touchRefs(repo *Repo) {
	repo.AdvVersion++
	repo.AdvCache = nil
	repo.PackCache = make(map[string]*packEntry)
	repo.FetchCache = make(map[string][]byte)
	repo.LsRefsCache = make(map[string][]byte)
}

// Base64url without padding, for GraphQL global ids.
func b64url(input string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(input))
}

// base64urlDecode decodes a base64url string (padded or not) to text.
func base64urlDecode(s string) (string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		raw, err = base64.URLEncoding.DecodeString(s)
		if err != nil {
			return "", err
		}
	}
	return string(raw), nil
}

func repoNodeID(repo *Repo) string {
	return b64url("Repository:" + itoa(repo.ID))
}

func issueNodeID(repo *Repo, issue *Issue) string {
	return b64url("Issue:" + itoa(repo.ID) + ":" + itoa(issue.Number))
}

func pullNodeID(repo *Repo, pull *Pull) string {
	return b64url("PullRequest:" + itoa(repo.ID) + ":" + itoa(pull.Number))
}

func commentNodeID(repo *Repo, comment *Comment) string {
	return b64url("IssueComment:" + itoa(repo.ID) + ":" + itoa(comment.ID))
}

// decodeNodeID decodes a global id back into its parts; nil when it is not one
// of ours. Repository ids are `Repository:<id>` (2 parts); Issue/PullRequest/
// IssueComment ids are `<Kind>:<repoId>:<num>` (3 parts).
func decodeNodeID(id string) (kind string, repoID, num int, ok bool) {
	raw, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil {
		// Also accept padded base64url (defensive; our encoder never emits it).
		raw, err = base64.URLEncoding.DecodeString(id)
		if err != nil {
			return "", 0, 0, false
		}
	}
	parts := strings.Split(string(raw), ":")
	if len(parts) < 2 || len(parts) > 3 {
		return "", 0, 0, false
	}
	kind = parts[0]
	repoID, err = atoi(parts[1])
	if err != nil {
		return "", 0, 0, false
	}
	num = 0
	if len(parts) == 3 {
		num, err = atoi(parts[2])
		if err != nil {
			return "", 0, 0, false
		}
	}
	return kind, repoID, num, true
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func atoi(s string) (int, error) {
	if s == "" {
		return 0, errBadInt
	}
	neg := false
	if s[0] == '-' {
		neg = true
		s = s[1:]
		if s == "" {
			return 0, errBadInt
		}
	}
	n := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0, errBadInt
		}
		n = n*10 + int(c-'0')
	}
	if neg {
		n = -n
	}
	return n, nil
}

type badIntError struct{}

func (badIntError) Error() string { return "invalid integer" }

var errBadInt = badIntError{}
