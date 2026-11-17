// Git object model, packfile codec and pkt-line framing. Pure Go stdlib.
// Packs we SEND are always full objects (no deltas): a real git client accepts
// them and they are far cheaper to build. Packs we RECEIVE may carry deltas
// (the suite's client sends them), so the reader resolves OFS_DELTA and
// REF_DELTA.

package main

import (
	"bytes"
	"compress/zlib"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

const zeroOID = "0000000000000000000000000000000000000000"

func sha1Hex(data []byte) string {
	h := sha1.Sum(data)
	return hex.EncodeToString(h[:])
}

// objectID returns the id of an object: sha1("<type> <len>\0" + content).
func objectID(typ string, data []byte) string {
	h := sha1.New()
	h.Write([]byte(typ + " " + itoa(len(data)) + "\x00"))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

func getObject(repo *Repo, oid string) *GitObject {
	if repo == nil {
		return nil
	}
	return repo.Objects[oid]
}

func putObject(repo *Repo, typ string, data []byte) string {
	oid := objectID(typ, data)
	if _, ok := repo.Objects[oid]; !ok {
		repo.Objects[oid] = &GitObject{Type: typ, Data: data}
	}
	return oid
}

// ---------------------------------------------------------------------------
// Tree and commit parsing
// ---------------------------------------------------------------------------

type TreeEntry struct {
	Mode string
	Name string
	OID  string
}

func parseTree(data []byte) []TreeEntry {
	var entries []TreeEntry
	off := 0
	for off < len(data) {
		space := bytes.IndexByte(data[off:], ' ')
		if space < 0 {
			break
		}
		space += off
		rawMode := string(data[off:space])
		// Git writes a directory's mode as `40000` (no leading zero); normalize
		// it to `040000` so every consumer sees one form. The oid is read from
		// the raw bytes, so this never changes an object's identity.
		mode := rawMode
		if rawMode == "40000" {
			mode = "040000"
		}
		nul := bytes.IndexByte(data[space:], 0)
		if nul < 0 {
			break
		}
		nul += space
		name := string(data[space+1 : nul])
		oid := hex.EncodeToString(data[nul+1 : nul+21])
		entries = append(entries, TreeEntry{Mode: mode, Name: name, OID: oid})
		off = nul + 21
	}
	return entries
}

func serializeTree(entries []TreeEntry) []byte {
	var buf bytes.Buffer
	for _, e := range entries {
		buf.WriteString(e.Mode)
		buf.WriteByte(' ')
		buf.WriteString(e.Name)
		buf.WriteByte(0)
		raw, _ := hex.DecodeString(e.OID)
		buf.Write(raw)
	}
	return buf.Bytes()
}

type Commit struct {
	Tree      string
	Parents   []string
	Author    string
	Committer string
	Message   string
	Raw       []byte
}

func parseCommit(data []byte) Commit {
	text := string(data)
	split := strings.Index(text, "\n\n")
	var header, message string
	if split >= 0 {
		header = text[:split]
		message = text[split+2:]
	} else {
		header = text
	}
	var tree string
	var parents []string
	var author, committer string
	for _, line := range strings.Split(header, "\n") {
		if strings.HasPrefix(line, "tree ") {
			tree = strings.TrimSpace(line[5:])
		} else if strings.HasPrefix(line, "parent ") {
			parents = append(parents, strings.TrimSpace(line[7:]))
		} else if strings.HasPrefix(line, "author ") {
			author = line[7:]
		} else if strings.HasPrefix(line, "committer ") {
			committer = line[10:]
		}
	}
	return Commit{Tree: tree, Parents: parents, Author: author, Committer: committer, Message: message, Raw: data}
}

func serializeCommit(tree string, parents []string, author, committer, message string) []byte {
	var sb strings.Builder
	sb.WriteString("tree " + tree + "\n")
	for _, p := range parents {
		sb.WriteString("parent " + p + "\n")
	}
	sb.WriteString("author " + author + "\n")
	sb.WriteString("committer " + committer + "\n\n")
	sb.WriteString(message)
	return []byte(sb.String())
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

type oidDepth struct {
	oid   string
	depth int
}

// reachableObjects returns all objects reachable from `roots` (commits walk
// parents, trees, blobs).
func reachableObjects(repo *Repo, roots []string, maxDepth int) map[string]*GitObject {
	out := make(map[string]*GitObject)
	queue := make([]oidDepth, 0, len(roots))
	for _, oid := range roots {
		queue = append(queue, oidDepth{oid, 0})
	}
	seenCommits := make(map[string]bool)
	for len(queue) > 0 {
		cur := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		obj := repo.Objects[cur.oid]
		if obj == nil {
			continue
		}
		if _, ok := out[cur.oid]; ok {
			continue
		}
		out[cur.oid] = obj
		if obj.Type == "commit" {
			if seenCommits[cur.oid] {
				continue
			}
			seenCommits[cur.oid] = true
			c := parseCommit(obj.Data)
			// A commit's own tree and blobs always travel with it; only parent
			// expansion stops at the depth limit (shallow boundary). A commit
			// at depth d is included iff d < maxDepth, so parents (depth d+1)
			// are pushed only when d+1 < maxDepth. maxDepth < 0 means no limit.
			if c.Tree != "" {
				queue = append(queue, oidDepth{c.Tree, cur.depth})
			}
			if maxDepth < 0 || cur.depth+1 < maxDepth {
				for _, p := range c.Parents {
					queue = append(queue, oidDepth{p, cur.depth + 1})
				}
			}
		} else if obj.Type == "tree" {
			for _, e := range parseTree(obj.Data) {
				queue = append(queue, oidDepth{e.OID, cur.depth})
			}
		}
	}
	return out
}

// commitDepth returns the depth (generations) from any root to `target`, or -1.
func commitDepth(repo *Repo, roots []string, target string) int {
	queue := make([]oidDepth, 0, len(roots))
	for _, oid := range roots {
		queue = append(queue, oidDepth{oid, 0})
	}
	seen := make(map[string]bool)
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if cur.oid == target {
			return cur.depth
		}
		if seen[cur.oid] {
			continue
		}
		seen[cur.oid] = true
		obj := repo.Objects[cur.oid]
		if obj == nil || obj.Type != "commit" {
			continue
		}
		for _, p := range parseCommit(obj.Data).Parents {
			queue = append(queue, oidDepth{p, cur.depth + 1})
		}
	}
	return -1
}

// isAncestor is true when `ancestor` is reachable from `tip` (or equal).
func isAncestor(repo *Repo, ancestor, tip string) bool {
	if ancestor == tip {
		return true
	}
	queue := []string{tip}
	seen := make(map[string]bool)
	for len(queue) > 0 {
		oid := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if oid == ancestor {
			return true
		}
		if seen[oid] {
			continue
		}
		seen[oid] = true
		obj := repo.Objects[oid]
		if obj == nil || obj.Type != "commit" {
			continue
		}
		for _, p := range parseCommit(obj.Data).Parents {
			queue = append(queue, p)
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

func pktLine(payload []byte) []byte {
	body := payload
	l := len(body) + 4
	head := []byte(fmt.Sprintf("%04x", l))
	out := make([]byte, 0, l)
	out = append(out, head...)
	out = append(out, body...)
	return out
}

func pktLineStr(s string) []byte { return pktLine([]byte(s)) }

var flushPkt = []byte("0000")
var delimPkt = []byte("0001")

type pktKind int

const (
	pktData pktKind = iota
	pktFlush
	pktDelim
)

type pkt struct {
	kind    pktKind
	payload []byte
}

// parsePktLines splits a buffer into pkt-line packets. Errors on garbage.
func parsePktLines(buf []byte) ([]pkt, error) {
	var out []pkt
	off := 0
	for off < len(buf) {
		if off+4 > len(buf) {
			return nil, errors.New("truncated pkt-line")
		}
		n, err := strconv.ParseInt(string(buf[off:off+4]), 16, 32)
		if err != nil {
			return nil, errors.New("bad pkt-line length")
		}
		length := int(n)
		if length == 0 {
			out = append(out, pkt{kind: pktFlush})
			off += 4
		} else if length == 1 {
			out = append(out, pkt{kind: pktDelim})
			off += 4
		} else {
			if off+length > len(buf) {
				return nil, errors.New("truncated pkt-line payload")
			}
			out = append(out, pkt{kind: pktData, payload: buf[off+4 : off+length]})
			off += length
		}
	}
	return out, nil
}

// sidebandPacket builds a sideband packet: band byte + data, framed as one
// pkt-line (max 65520).
func sidebandPacket(band byte, data []byte) []byte {
	payload := make([]byte, 0, len(data)+1)
	payload = append(payload, band)
	payload = append(payload, data...)
	return pktLine(payload)
}

// sidebandData splits data into sideband band-1 packets of at most 65515 payload bytes.
func sidebandData(data []byte) [][]byte {
	const max = 65515
	var out [][]byte
	for off := 0; off < len(data); off += max {
		end := off + max
		if end > len(data) {
			end = len(data)
		}
		out = append(out, sidebandPacket(1, data[off:end]))
	}
	if len(data) == 0 {
		out = append(out, sidebandPacket(1, nil))
	}
	return out
}

// ---------------------------------------------------------------------------
// Pack writing (full objects only, no deltas)
// ---------------------------------------------------------------------------

var packTypes = map[string]int{"commit": 1, "tree": 2, "blob": 3, "tag": 4}
var packTypeNames = map[int]string{1: "commit", 2: "tree", 3: "blob", 4: "tag"}

func encodeObjectHeader(typeNum, size int) []byte {
	var out []byte
	b := byte((typeNum << 4) | (size & 0x0f))
	size >>= 4
	if size > 0 {
		b |= 0x80
	}
	out = append(out, b)
	for size > 0 {
		b = byte(size & 0x7f)
		size >>= 7
		if size > 0 {
			b |= 0x80
		}
		out = append(out, b)
	}
	return out
}

func deflate(data []byte) []byte {
	var buf bytes.Buffer
	w, _ := zlib.NewWriterLevel(&buf, zlib.DefaultCompression)
	w.Write(data)
	w.Close()
	return buf.Bytes()
}

func buildPack(objects map[string]*GitObject) []byte {
	// Sort by oid for a deterministic pack.
	oids := make([]string, 0, len(objects))
	for oid := range objects {
		oids = append(oids, oid)
	}
	sort.Strings(oids)
	var body bytes.Buffer
	body.WriteString("PACK")
	var hdr [8]byte
	hdr[0] = 0
	hdr[1] = 0
	hdr[2] = 0
	hdr[3] = 2
	n := len(oids)
	hdr[4] = byte(n >> 24)
	hdr[5] = byte(n >> 16)
	hdr[6] = byte(n >> 8)
	hdr[7] = byte(n)
	body.Write(hdr[:])
	for _, oid := range oids {
		obj := objects[oid]
		typeNum := packTypes[obj.Type]
		body.Write(encodeObjectHeader(typeNum, len(obj.Data)))
		// An object that arrived as a pack entry keeps its validated deflated
		// bytes: concatenating them is far cheaper than deflating again.
		if obj.Deflated != nil {
			body.Write(obj.Deflated)
		} else {
			body.Write(deflate(obj.Data))
		}
	}
	packed := body.Bytes()
	sum := sha1.Sum(packed)
	out := make([]byte, 0, len(packed)+20)
	out = append(out, packed...)
	out = append(out, sum[:]...)
	return out
}

// ---------------------------------------------------------------------------
// Pack reading (with delta resolution)
// ---------------------------------------------------------------------------

func readVarint(buf []byte, off int) (value, next int) {
	value = int(buf[off] & 0x7f)
	next = off + 1
	for buf[off]&0x80 != 0 {
		value = ((value + 1) << 7) | int(buf[next]&0x7f)
		off = next
		next++
	}
	return value, next
}

func applyDelta(base, delta []byte) ([]byte, error) {
	off := 0
	readDeltaVarint := func() int {
		v := 0
		shift := uint(0)
		for {
			b := delta[off]
			off++
			v |= int(b&0x7f) << shift
			shift += 7
			if b&0x80 == 0 {
				break
			}
		}
		return v
	}
	srcSize := readDeltaVarint()
	dstSize := readDeltaVarint()
	if srcSize != len(base) {
		return nil, errors.New("delta base size mismatch")
	}
	var out [][]byte
	total := 0
	for off < len(delta) {
		op := delta[off]
		off++
		if op&0x80 != 0 {
			cpOff := 0
			cpSize := 0
			for i := 0; i < 4; i++ {
				if op&(1<<uint(i)) != 0 {
					cpOff |= int(delta[off]) << (8 * uint(i))
					off++
				}
			}
			for i := 0; i < 3; i++ {
				if op&(0x10<<uint(i)) != 0 {
					cpSize |= int(delta[off]) << (8 * uint(i))
					off++
				}
			}
			if cpSize == 0 {
				cpSize = 0x10000
			}
			out = append(out, base[cpOff:cpOff+cpSize])
			total += cpSize
		} else if op > 0 {
			out = append(out, delta[off:off+int(op)])
			off += int(op)
			total += int(op)
		} else {
			return nil, errors.New("delta opcode 0")
		}
	}
	// Concatenate.
	size := 0
	for _, p := range out {
		size += len(p)
	}
	result := make([]byte, 0, size)
	for _, p := range out {
		result = append(result, p...)
	}
	if len(result) != dstSize || total != dstSize {
		return nil, errors.New("delta size mismatch")
	}
	return result, nil
}

type readPackResult struct {
	objects    map[string]*GitObject
	deltaCount int
}

type pendingDelta struct {
	offset  int
	typ     int
	baseOff int // -1 when unset
	baseOID string
	data    []byte
}

// readPack parses a whole packfile. resolveRefBase looks up REF_DELTA bases
// already in the store.
func readPack(pack []byte, resolveRefBase func(oid string) *GitObject) (*readPackResult, error) {
	if len(pack) < 32 || string(pack[0:4]) != "PACK" {
		return nil, errors.New("not a packfile")
	}
	version := int(pack[4])<<24 | int(pack[5])<<16 | int(pack[6])<<8 | int(pack[7])
	if version != 2 {
		return nil, fmt.Errorf("unsupported pack version %d", version)
	}
	count := int(pack[8])<<24 | int(pack[9])<<16 | int(pack[10])<<8 | int(pack[11])
	trailer := pack[len(pack)-20:]
	actual := sha1.Sum(pack[:len(pack)-20])
	if hex.EncodeToString(actual[:]) != hex.EncodeToString(trailer) {
		return nil, errors.New("pack trailer checksum mismatch")
	}

	objects := make(map[string]*GitObject)
	byOffset := make(map[int]*GitObject)
	deltaCount := 0
	off := 12
	var pending []pendingDelta
	for i := 0; i < count; i++ {
		entryStart := off
		b := pack[off]
		off++
		typ := int((b >> 4) & 0x7)
		size := int(b & 0x0f)
		shift := uint(4)
		for b&0x80 != 0 {
			b = pack[off]
			off++
			size |= int(b&0x7f) << shift
			shift += 7
		}
		baseOff := -1
		var baseOID string
		if typ == 6 {
			v, next := readVarint(pack, off)
			baseOff = entryStart - v
			off = next
		} else if typ == 7 {
			baseOID = hex.EncodeToString(pack[off : off+20])
			off += 20
		}
		// Inflate the stream once. The zlib reader reads from a *bytes.Reader,
		// which implements io.ByteReader, so the flate decoder pulls bytes
		// one at a time and never reads ahead: the reader's remaining length
		// tells us exactly where this entry's compressed data ends.
		streamStart := off
		br := bytes.NewReader(pack[off:])
		zr, err := zlib.NewReader(br)
		if err != nil {
			return nil, err
		}
		inflated, err := io.ReadAll(zr)
		zr.Close()
		if err != nil {
			return nil, err
		}
		consumed := len(pack[off:]) - br.Len()
		off = streamStart + consumed
		_ = size
		if typ == 6 || typ == 7 {
			deltaCount++
			pending = append(pending, pendingDelta{offset: entryStart, typ: typ, baseOff: baseOff, baseOID: baseOID, data: inflated})
		} else {
			name := packTypeNames[typ]
			oid := objectID(name, inflated)
			obj := &GitObject{Type: name, Data: inflated, Deflated: pack[streamStart:off]}
			objects[oid] = obj
			byOffset[entryStart] = obj
		}
	}
	var resolveOne func(p pendingDelta, depth int) (*GitObject, error)
	resolveOne = func(p pendingDelta, depth int) (*GitObject, error) {
		if depth > 64 {
			return nil, errors.New("delta chain too deep")
		}
		var base *GitObject
		if p.baseOff >= 0 {
			base = byOffset[p.baseOff]
			if base == nil {
				for _, bp := range pending {
					if bp.offset == p.baseOff {
						var err error
						base, err = resolveOne(bp, depth+1)
						if err != nil {
							return nil, err
						}
						break
					}
				}
				if base == nil {
					return nil, errors.New("ofs-delta base missing")
				}
			}
		} else if p.baseOID != "" {
			base = objects[p.baseOID]
			if base == nil && resolveRefBase != nil {
				base = resolveRefBase(p.baseOID)
			}
			if base == nil {
				for _, bp := range pending {
					if bp.typ != 6 && bp.typ != 7 {
						oid := objectID(packTypeNames[bp.typ], bp.data)
						if oid == p.baseOID {
							var err error
							base, err = resolveOne(bp, depth+1)
							if err != nil {
								return nil, err
							}
							break
						}
					}
				}
			}
			if base == nil {
				return nil, fmt.Errorf("ref-delta base %s missing", p.baseOID)
			}
		} else {
			return nil, errors.New("delta without base")
		}
		data, err := applyDelta(base.Data, p.data)
		if err != nil {
			return nil, err
		}
		oid := objectID(base.Type, data)
		obj := &GitObject{Type: base.Type, Data: data}
		objects[oid] = obj
		byOffset[p.offset] = obj
		return obj, nil
	}
	for _, p := range pending {
		if _, ok := byOffset[p.offset]; !ok {
			if _, err := resolveOne(p, 0); err != nil {
				return nil, err
			}
		}
	}
	return &readPackResult{objects: objects, deltaCount: deltaCount}, nil
}


