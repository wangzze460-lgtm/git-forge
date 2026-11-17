// git smart-HTTP protocol handlers: upload-pack v2 + v0, receive-pack v0.
// All state lives in the store; packs we send carry full objects only.

package main

import (
	"bytes"
	"sort"
	"strconv"
	"strings"
)

const agentStr = "agent=forge/1.0"

// sortedRefs returns all refs sorted by name.
func sortedRefs(repo *Repo) []refEntry {
	out := make([]refEntry, 0, len(repo.Refs))
	for name, oid := range repo.Refs {
		out = append(out, refEntry{name, oid})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

type refEntry struct {
	name string
	oid  string
}

func headOID(repo *Repo) (string, bool) {
	oid, ok := repo.Refs["refs/heads/"+repo.DefaultBranch]
	return oid, ok
}

// peelToCommit peels an annotated tag to its target commit, else returns the oid itself.
func peelToCommit(repo *Repo, oid string) string {
	obj := getObject(repo, oid)
	if obj == nil {
		return oid
	}
	if obj.Type == "tag" {
		text := string(obj.Data)
		for _, line := range strings.Split(text, "\n") {
			if strings.HasPrefix(line, "object ") {
				rest := strings.TrimSpace(line[7:])
				if len(rest) == 40 {
					return peelToCommit(repo, rest)
				}
			}
		}
	}
	return oid
}

// ---------------------------------------------------------------------------
// Advertisements (GET /info/refs)
// ---------------------------------------------------------------------------

// The v2 upload-pack advertisement is repo-independent (capabilities only, no
// refs), so build the bytes once and hand out the same buffer to every clone.
var uploadV2Adv = func() []byte {
	var buf bytes.Buffer
	buf.Write(pktLineStr("version 2\n"))
	buf.Write(pktLineStr(agentStr + "\n"))
	buf.Write(pktLineStr("ls-refs=unborn\n"))
	buf.Write(pktLineStr("fetch=shallow filter\n"))
	buf.Write(pktLineStr("object-format=sha1\n"))
	buf.Write(flushPkt)
	return buf.Bytes()
}()

func advertiseUploadV2(repo *Repo) []byte { return uploadV2Adv }

func advertiseV0(repo *Repo, service, caps string) []byte {
	var parts [][]byte
	parts = append(parts, pktLineStr("# service="+service+"\n"), flushPkt)
	refs := sortedRefs(repo)
	head, hasHead := headOID(repo)
	symref := "symref=HEAD:refs/heads/" + repo.DefaultBranch
	if len(refs) == 0 {
		parts = append(parts, pktLineStr(zeroOID+" capabilities^{}\x00"+caps+" "+symref+" "+agentStr+"\n"))
	} else {
		// v0 requires the capabilities on the FIRST ref line: HEAD goes first,
		// carrying them.
		capsSent := false
		if hasHead {
			parts = append(parts, pktLineStr(head+" HEAD\x00"+caps+" "+symref+" "+agentStr+"\n"))
			capsSent = true
		}
		for _, r := range refs {
			peeled := peelToCommit(repo, r.oid)
			if !capsSent {
				parts = append(parts, pktLineStr(r.oid+" "+r.name+"\x00"+caps+" "+agentStr+"\n"))
				capsSent = true
			} else {
				parts = append(parts, pktLineStr(r.oid+" "+r.name+"\n"))
			}
			if peeled != r.oid {
				parts = append(parts, pktLineStr(peeled+" "+r.name+"^{}\n"))
			}
		}
	}
	parts = append(parts, flushPkt)
	return concatBytes(parts)
}

func concatBytes(parts [][]byte) []byte {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	out := make([]byte, 0, n)
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func advertiseUploadV0(repo *Repo) []byte {
	return advertiseV0(repo, "git-upload-pack", "side-band-64k")
}

func advertiseReceiveV0(repo *Repo) []byte {
	return advertiseV0(repo, "git-receive-pack", "report-status side-band-64k delete-refs")
}

// ---------------------------------------------------------------------------
// upload-pack v2: ls-refs
// ---------------------------------------------------------------------------

type lsRefsOpts struct {
	peel     bool
	symrefs  bool
	unborn   bool
	prefixes []string
}

func handleLsRefs(repo *Repo, body []byte) []byte {
	pkts, err := parsePktLines(body)
	if err != nil {
		return nil
	}
	var opts lsRefsOpts
	for _, p := range pkts {
		if p.kind != pktData {
			continue
		}
		line := strings.TrimSpace(string(p.payload))
		if line == "peel" {
			opts.peel = true
		} else if line == "symrefs" {
			opts.symrefs = true
		} else if line == "unborn" {
			opts.unborn = true
		} else if strings.HasPrefix(line, "ref-prefix ") {
			opts.prefixes = append(opts.prefixes, line[len("ref-prefix "):])
		}
	}
	// Identical ls-refs share one cached reply, keyed by ref-version + options.
	var keyBuf strings.Builder
	keyBuf.WriteString(itoa(repo.AdvVersion))
	keyBuf.WriteByte('|')
	if opts.peel {
		keyBuf.WriteByte('p')
	}
	if opts.symrefs {
		keyBuf.WriteByte('s')
	}
	if opts.unborn {
		keyBuf.WriteByte('u')
	}
	keyBuf.WriteByte('|')
	keyBuf.WriteString(strings.Join(opts.prefixes, ","))
	lsKey := keyBuf.String()
	if cached, ok := repo.LsRefsCache[lsKey]; ok {
		return cached
	}
	var out [][]byte
	head, hasHead := headOID(repo)
	matches := func(name string) bool {
		if len(opts.prefixes) == 0 {
			return true
		}
		for _, pre := range opts.prefixes {
			if strings.HasPrefix(name, pre) {
				return true
			}
		}
		return false
	}
	if hasHead {
		if matches("HEAD") {
			peeled := peelToCommit(repo, head)
			line := head + " HEAD"
			if opts.symrefs {
				line += " symref-target:refs/heads/" + repo.DefaultBranch
			}
			if opts.peel && peeled != head {
				line += " peeled:" + peeled
			}
			out = append(out, pktLineStr(line+"\n"))
		}
	} else if opts.unborn {
		if matches("HEAD") {
			line := "unborn HEAD"
			if opts.symrefs {
				line += " symref-target:refs/heads/" + repo.DefaultBranch
			}
			out = append(out, pktLineStr(line+"\n"))
		}
	}
	for _, r := range sortedRefs(repo) {
		if !matches(r.name) {
			continue
		}
		peeled := peelToCommit(repo, r.oid)
		line := r.oid + " " + r.name
		if opts.peel && peeled != r.oid {
			line += " peeled:" + peeled
		}
		out = append(out, pktLineStr(line+"\n"))
	}
	out = append(out, flushPkt)
	lsOut := concatBytes(out)
	repo.LsRefsCache[lsKey] = lsOut
	return lsOut
}

// ---------------------------------------------------------------------------
// upload-pack v2 + v0: fetch
// ---------------------------------------------------------------------------

type fetchRequest struct {
	wants   []string
	haves   []string
	shallow []string
	deepen  int  // -1 when absent
	hasDeep bool
}

func fetchKey(repo *Repo, req *fetchRequest) string {
	depth := "inf"
	if req.hasDeep {
		depth = itoa(req.deepen)
	}
	return itoa(repo.AdvVersion) + "|" + strings.Join(req.wants, ",") + "|" + depth + "|" +
		strings.Join(req.haves, ",") + "|" + strings.Join(req.shallow, ",")
}

type fetchResult struct {
	pack      []byte
	shallow   []string
	unshallow []string
	acked     []string
}

// computeFetch computes the pack + shallow info for a fetch.
func computeFetch(repo *Repo, req *fetchRequest) fetchResult {
	depthLimit := -1 // -1 = infinity
	if req.hasDeep {
		depthLimit = req.deepen
	}
	cacheKey := fetchKey(repo, req)
	if cached, ok := repo.PackCache[cacheKey]; ok {
		var acked []string
		for _, h := range req.haves {
			for _, w := range req.wants {
				if isAncestor(repo, h, w) {
					acked = append(acked, h)
					break
				}
			}
		}
		return fetchResult{pack: cached.Pack, shallow: cached.Shallow, unshallow: cached.Unshallow, acked: acked}
	}
	include := reachableObjects(repo, req.wants, depthLimit)
	exclude := make(map[string]bool)
	shallowSet := make(map[string]bool)
	for _, s := range req.shallow {
		shallowSet[s] = true
	}
	for _, h := range req.haves {
		depth := -1
		if shallowSet[h] {
			depth = 0
		}
		for oid := range reachableObjects(repo, []string{h}, depth) {
			exclude[oid] = true
		}
	}
	for _, b := range req.shallow {
		for oid := range reachableObjects(repo, []string{b}, 0) {
			exclude[oid] = true
		}
	}
	packObjs := make(map[string]*GitObject)
	for oid, obj := range include {
		if !exclude[oid] {
			packObjs[oid] = obj
		}
	}
	// New shallow boundary: included commits with a parent outside the included set.
	var shallow []string
	if depthLimit != -1 {
		for oid, obj := range include {
			if obj.Type != "commit" {
				continue
			}
			c := parseCommit(obj.Data)
			for _, p := range c.Parents {
				if !includeHas(include, p) {
					shallow = append(shallow, oid)
					break
				}
			}
		}
		sort.Strings(shallow)
	}
	// Unshallow: a sent boundary whose parents are now all included.
	var unshallow []string
	for _, b := range req.shallow {
		obj := getObject(repo, b)
		if obj == nil || obj.Type != "commit" {
			continue
		}
		c := parseCommit(obj.Data)
		if !includeHas(include, b) {
			continue
		}
		all := true
		for _, p := range c.Parents {
			if !includeHas(include, p) {
				all = false
				break
			}
		}
		if all {
			unshallow = append(unshallow, b)
		}
	}
	var acked []string
	for _, h := range req.haves {
		for _, w := range req.wants {
			if isAncestor(repo, h, w) {
				acked = append(acked, h)
				break
			}
		}
	}
	pack := buildPack(packObjs)
	repo.PackCache[cacheKey] = &packEntry{Pack: pack, Shallow: shallow, Unshallow: unshallow}
	return fetchResult{pack: pack, shallow: shallow, unshallow: unshallow, acked: acked}
}

func includeHas(m map[string]*GitObject, oid string) bool {
	_, ok := m[oid]
	return ok
}

func handleFetchV2(repo *Repo, body []byte) []byte {
	pkts, err := parsePktLines(body)
	if err != nil {
		return nil
	}
	req := &fetchRequest{deepen: -1}
	for _, p := range pkts {
		if p.kind != pktData {
			continue
		}
		line := strings.TrimSpace(string(p.payload))
		switch {
		case strings.HasPrefix(line, "want "):
			req.wants = append(req.wants, strings.SplitN(line[5:], " ", 2)[0])
		case strings.HasPrefix(line, "have "):
			req.haves = append(req.haves, strings.TrimSpace(line[5:]))
		case strings.HasPrefix(line, "shallow "):
			req.shallow = append(req.shallow, strings.TrimSpace(line[8:]))
		case strings.HasPrefix(line, "deepen "):
			if n, err := strconv.Atoi(strings.TrimSpace(line[7:])); err == nil {
				req.deepen = n
				req.hasDeep = true
			}
		}
	}
	key := fetchKey(repo, req)
	if cached, ok := repo.FetchCache[key]; ok {
		return cached
	}
	res := computeFetch(repo, req)
	var parts [][]byte
	// Real git servers send the acknowledgments section ONLY when the client
	// sent `have` lines. A clone sends none, so the response must start
	// straight at `packfile`.
	if len(req.haves) > 0 {
		parts = append(parts, pktLineStr("acknowledgments\n"))
		if len(res.acked) > 0 {
			for _, a := range res.acked {
				parts = append(parts, pktLineStr("ACK "+a+"\n"))
			}
			parts = append(parts, pktLineStr("ready\n"))
		} else {
			parts = append(parts, pktLineStr("NAK\n"))
		}
		parts = append(parts, delimPkt)
	}
	if len(res.shallow) > 0 || len(res.unshallow) > 0 {
		parts = append(parts, pktLineStr("shallow-info\n"))
		for _, s := range res.shallow {
			parts = append(parts, pktLineStr("shallow "+s+"\n"))
		}
		for _, u := range res.unshallow {
			parts = append(parts, pktLineStr("unshallow "+u+"\n"))
		}
		parts = append(parts, delimPkt)
	}
	parts = append(parts, pktLineStr("packfile\n"))
	parts = append(parts, sidebandData(res.pack)...)
	parts = append(parts, flushPkt)
	out := concatBytes(parts)
	repo.FetchCache[key] = out
	return out
}

func handleFetchV0(repo *Repo, body []byte) []byte {
	pkts, err := parsePktLines(body)
	if err != nil {
		return nil
	}
	req := &fetchRequest{deepen: -1}
	seenFlush := false
	for _, p := range pkts {
		if p.kind == pktFlush {
			seenFlush = true
			continue
		}
		if p.kind != pktData {
			continue
		}
		line := strings.TrimSpace(string(p.payload))
		switch {
		case strings.HasPrefix(line, "want "):
			req.wants = append(req.wants, strings.SplitN(line[5:], " ", 2)[0])
		case strings.HasPrefix(line, "shallow "):
			req.shallow = append(req.shallow, strings.TrimSpace(line[8:]))
		case strings.HasPrefix(line, "deepen "):
			if n, err := strconv.Atoi(strings.TrimSpace(line[7:])); err == nil {
				req.deepen = n
				req.hasDeep = true
			}
		case seenFlush && strings.HasPrefix(line, "have "):
			req.haves = append(req.haves, strings.TrimSpace(line[5:]))
		}
	}
	key := fetchKey(repo, req)
	if cached, ok := repo.FetchCache[key]; ok {
		return cached
	}
	res := computeFetch(repo, req)
	var parts [][]byte
	if len(res.acked) > 0 {
		for _, a := range res.acked {
			parts = append(parts, pktLineStr("ACK "+a+"\n"))
		}
	} else {
		parts = append(parts, pktLineStr("NAK\n"))
	}
	parts = append(parts, sidebandData(res.pack)...)
	parts = append(parts, flushPkt)
	out := concatBytes(parts)
	repo.FetchCache[key] = out
	return out
}

// ---------------------------------------------------------------------------
// receive-pack v0
// ---------------------------------------------------------------------------

type pushCommand struct {
	oldOID string
	newOID string
	ref    string
}

var receiveReportCache = make(map[string][]byte)

func handleReceivePack(repo *Repo, body []byte) []byte {
	// Split commands (pkt-lines up to the first flush) from the raw packfile.
	off := 0
	var commands []pushCommand
	packStart := len(body)
	for off+4 <= len(body) {
		n, err := strconv.ParseInt(string(body[off:off+4]), 16, 32)
		if err != nil {
			break
		}
		length := int(n)
		if length == 0 {
			packStart = off + 4
			break
		}
		if length == 1 {
			off += 4
			continue
		}
		payload := string(body[off+4 : off+length])
		if nul := strings.IndexByte(payload, 0); nul >= 0 {
			payload = payload[:nul]
		}
		line := strings.TrimSpace(payload)
		parts := strings.SplitN(line, " ", 3)
		if len(parts) == 3 && len(parts[0]) == 40 && len(parts[1]) == 40 {
			commands = append(commands, pushCommand{oldOID: parts[0], newOID: parts[1], ref: parts[2]})
		}
		off += length
	}
	type reportLine struct {
		ref    string
		ok     bool
		reason string
	}
	var report []reportLine
	unpackOK := true
	unpackErr := ""
	packBytes := body[packStart:]
	if len(packBytes) >= 12 {
		res, err := readPack(packBytes, func(oid string) *GitObject { return getObject(repo, oid) })
		if err != nil {
			unpackOK = false
			unpackErr = err.Error()
		} else {
			for oid, obj := range res.objects {
				if _, ok := repo.Objects[oid]; !ok {
					repo.Objects[oid] = obj
				}
			}
		}
	}
	if unpackOK {
		for _, cmd := range commands {
			current, exists := repo.Refs[cmd.ref]
			switch {
			case cmd.newOID == zeroOID && cmd.oldOID == zeroOID:
				report = append(report, reportLine{cmd.ref, false, "invalid command"})
			case cmd.newOID == zeroOID:
				// Delete.
				if !exists {
					report = append(report, reportLine{cmd.ref, false, "reference does not exist"})
				} else if cmd.oldOID != zeroOID && cmd.oldOID != current {
					report = append(report, reportLine{cmd.ref, false, "old value does not match"})
				} else {
					delete(repo.Refs, cmd.ref)
					report = append(report, reportLine{cmd.ref, true, ""})
				}
			default:
				target := getObject(repo, cmd.newOID)
				if target == nil {
					report = append(report, reportLine{cmd.ref, false, "object not found"})
					continue
				}
				if cmd.oldOID == zeroOID {
					// Create.
					if exists {
						report = append(report, reportLine{cmd.ref, false, "reference already exists"})
					} else {
						repo.Refs[cmd.ref] = cmd.newOID
						report = append(report, reportLine{cmd.ref, true, ""})
					}
					continue
				}
				// Update.
				if !exists {
					report = append(report, reportLine{cmd.ref, false, "reference does not exist"})
				} else if current != cmd.oldOID {
					report = append(report, reportLine{cmd.ref, false, "old value does not match"})
				} else if target.Type == "commit" && !isAncestor(repo, cmd.oldOID, cmd.newOID) {
					report = append(report, reportLine{cmd.ref, false, "non-fast-forward"})
				} else {
					repo.Refs[cmd.ref] = cmd.newOID
					report = append(report, reportLine{cmd.ref, true, ""})
				}
			}
		}
		anyOK := false
		for _, r := range report {
			if r.ok {
				anyOK = true
				break
			}
		}
		if anyOK {
			repo.AdvCache = nil
			repo.PackCache = make(map[string]*packEntry)
			repo.FetchCache = make(map[string][]byte)
			repo.LsRefsCache = make(map[string][]byte)
			repo.AdvVersion++
		}
	}
	var lines []string
	if unpackOK {
		lines = append(lines, "unpack ok\n")
	} else {
		lines = append(lines, "unpack "+unpackErr+"\n")
	}
	for _, r := range report {
		if r.ok {
			lines = append(lines, "ok "+r.ref+"\n")
		} else {
			lines = append(lines, "ng "+r.ref+" "+r.reason+"\n")
		}
	}
	// The report is byte-identical for identical lines, so cache it.
	reportKey := strings.Join(lines, "")
	if cached, ok := receiveReportCache[reportKey]; ok {
		return cached
	}
	// The report is one band-1 stream: every report line as a pkt-line,
	// terminated by a flush INSIDE the band-1 payload, then a bare flush ends
	// the response.
	var reportPayload []byte
	for _, line := range lines {
		reportPayload = append(reportPayload, pktLineStr(line)...)
	}
	reportPayload = append(reportPayload, flushPkt...)
	var parts [][]byte
	const maxSideband = 65515
	for off := 0; off < len(reportPayload); off += maxSideband {
		end := off + maxSideband
		if end > len(reportPayload) {
			end = len(reportPayload)
		}
		parts = append(parts, sidebandPacket(1, reportPayload[off:end]))
	}
	parts = append(parts, flushPkt)
	out := concatBytes(parts)
	receiveReportCache[reportKey] = out
	return out
}
