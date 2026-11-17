// Minimal HTTP/1.1 server on raw TCP, written for this forge's traffic only.
// Every request here is small and sequential (2,000 issue reads on one
// keep-alive connection, 200 sequential pushes), so the per-request cost of a
// full HTTP stack is a large share of the time. This server parses the request
// line and the headers the handlers read, reads the body by Content-Length (or
// chunked), and writes one prebuilt byte slice per response. Sockets are
// no-delayed and keep-alive, so a connection serves many requests.
//
// Only HTTP/1.1 is spoken. A request the parser cannot read closes its socket.

package main

import (
	"bufio"
	"net"
	"strconv"
	"strings"
	"sync/atomic"
)

type dispatchFunc func(req *httpRequest) *httpResponse

type neededHeaders struct {
	authorization string
	gitProtocol   string
	host          string
	contentLength int
	hasLength     bool
	chunked       bool
	close         bool
}

var reasons = map[int]string{
	200: "OK",
	201: "Created",
	204: "No Content",
	400: "Bad Request",
	401: "Unauthorized",
	404: "Not Found",
	405: "Method Not Allowed",
	409: "Conflict",
	422: "Unprocessable Entity",
	500: "Internal Server Error",
}

var requestCounter int64

// parseHead parses the request line + headers from head (without the trailing
// blank line). Returns method, target, headers.
func parseHead(head string) (method, target string, h neededHeaders, ok bool) {
	// Split lines.
	lines := strings.Split(head, "\r\n")
	if len(lines) == 0 {
		return "", "", h, false
	}
	first := lines[0]
	sp1 := strings.IndexByte(first, ' ')
	if sp1 < 0 {
		return "", "", h, false
	}
	sp2 := strings.IndexByte(first[sp1+1:], ' ')
	if sp2 < 0 {
		return "", "", h, false
	}
	sp2 += sp1 + 1
	method = first[:sp1]
	target = first[sp1+1 : sp2]
	if method == "" || target == "" {
		return "", "", h, false
	}
	for _, line := range lines[1:] {
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue
		}
		name := strings.ToLower(strings.TrimSpace(line[:colon]))
		value := strings.TrimSpace(line[colon+1:])
		switch name {
		case "authorization":
			h.authorization = value
		case "git-protocol":
			h.gitProtocol = value
		case "host":
			h.host = value
		case "content-length":
			if n, err := strconv.Atoi(value); err == nil {
				h.contentLength = n
				h.hasLength = true
			}
		case "transfer-encoding":
			if strings.Contains(strings.ToLower(value), "chunked") {
				h.chunked = true
			}
		case "connection":
			if strings.Contains(strings.ToLower(value), "close") {
				h.close = true
			}
		}
	}
	return method, target, h, true
}

// readChunkedBody reads a chunked body from br. Returns the body or an error.
func readChunkedBody(br *bufio.Reader) ([]byte, error) {
	var body []byte
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimSpace(line)
		if semi := strings.IndexByte(line, ';'); semi >= 0 {
			line = line[:semi]
		}
		size, err := strconv.ParseInt(line, 16, 64)
		if err != nil || size < 0 {
			return nil, errBadChunk
		}
		if size == 0 {
			// Terminal chunk: one more CRLF (trailers ignored).
			if _, err := br.ReadString('\n'); err != nil {
				return nil, err
			}
			return body, nil
		}
		chunk := make([]byte, size)
		if _, err := readFull(br, chunk); err != nil {
			return nil, err
		}
		// Trailing CRLF after the chunk.
		if _, err := br.ReadString('\n'); err != nil {
			return nil, err
		}
		body = append(body, chunk...)
	}
}

func readFull(br *bufio.Reader, buf []byte) (int, error) {
	n := 0
	for n < len(buf) {
		m, err := br.Read(buf[n:])
		n += m
		if err != nil {
			return n, err
		}
	}
	return n, nil
}

type chunkError struct{}

func (chunkError) Error() string { return "bad chunked body" }

var errBadChunk = chunkError{}

// responseBytes builds the response bytes: status line + headers + blank line
// + body. Every header the handler set is sent; a content-length is added
// only when the handler did not set one.
func responseBytes(res *httpResponse, requestID string) []byte {
	reason, ok := reasons[res.Status]
	if !ok {
		reason = "OK"
	}
	var sb strings.Builder
	sb.WriteString("HTTP/1.1 ")
	sb.WriteString(itoa(res.Status))
	sb.WriteByte(' ')
	sb.WriteString(reason)
	sb.WriteString("\r\n")
	hasLength := false
	hasRequestID := false
	for name, value := range res.Headers {
		lower := strings.ToLower(name)
		if lower == "content-length" {
			hasLength = true
		}
		if lower == "x-github-request-id" {
			hasRequestID = true
		}
		sb.WriteString(lower)
		sb.WriteString(": ")
		sb.WriteString(value)
		sb.WriteString("\r\n")
	}
	if !hasLength {
		sb.WriteString("content-length: ")
		sb.WriteString(itoa(len(res.Body)))
		sb.WriteString("\r\n")
	}
	if !hasRequestID {
		sb.WriteString("x-github-request-id: ")
		sb.WriteString(requestID)
		sb.WriteString("\r\n")
	}
	sb.WriteString("\r\n")
	head := []byte(sb.String())
	if len(res.Body) == 0 {
		return head
	}
	out := make([]byte, 0, len(head)+len(res.Body))
	out = append(out, head...)
	out = append(out, res.Body...)
	return out
}

// serveConn handles one TCP connection, answering every complete request on it.
func serveConn(conn net.Conn, dispatch dispatchFunc) {
	defer conn.Close()
	// No Nagle: small sequential requests stall when Nagle holds a tiny packet
	// waiting for an ACK the other side delays.
	if tc, ok := conn.(*net.TCPConn); ok {
		tc.SetNoDelay(true)
		tc.SetKeepAlive(true)
	}
	br := bufio.NewReaderSize(conn, 65536)
	for {
		// Read the head (up to the blank line).
		head, err := readHead(br)
		if err != nil {
			return
		}
		method, target, hdrs, ok := parseHead(head)
		if !ok {
			return
		}
		var body []byte
		if hdrs.chunked {
			body, err = readChunkedBody(br)
			if err != nil {
				return
			}
		} else {
			length := 0
			if hdrs.hasLength {
				length = hdrs.contentLength
			}
			if length < 0 {
				return
			}
			if length > 0 {
				body = make([]byte, length)
				if _, err := readFull(br, body); err != nil {
					return
				}
			}
		}
		// Split the target into pathname + query without a URL parse.
		path := target
		query := ""
		if q := strings.IndexByte(target, '?'); q >= 0 {
			path = target[:q]
			query = target[q+1:]
		}
		headers := make(map[string]string, 3)
		if hdrs.authorization != "" {
			headers["authorization"] = hdrs.authorization
		}
		if hdrs.gitProtocol != "" {
			headers["git-protocol"] = hdrs.gitProtocol
		}
		if hdrs.host != "" {
			headers["host"] = hdrs.host
		}
		host := hdrs.host
		if host == "" {
			host = "localhost"
		}
		req := &httpRequest{
			Method:  method,
			Path:    path,
			Query:   parseQuery(query),
			Headers: headers,
			Body:    body,
			Host:    host,
		}
		n := atomic.AddInt64(&requestCounter, 1)
		var res *httpResponse
		func() {
			defer func() {
				if r := recover(); r != nil {
					res = &httpResponse{Status: 500, Headers: map[string]string{"content-type": "application/json"}, Body: []byte(`{"message":"Internal error"}`)}
				}
			}()
			res = dispatch(req)
		}()
		bytes := responseBytes(res, "req-raw-"+itoa(int(n)))
		if _, err := conn.Write(bytes); err != nil {
			return
		}
		if hdrs.close {
			return
		}
	}
}

// readHead reads bytes until the blank line (\r\n\r\n) and returns the head
// text without the trailing blank line.
func readHead(br *bufio.Reader) (string, error) {
	var sb strings.Builder
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return "", err
		}
		sb.WriteString(line)
		if line == "\r\n" {
			// End of head. Strip the trailing blank line.
			s := sb.String()
			return s[:len(s)-2], nil
		}
		if sb.Len() > 65536 {
			return "", errBadChunk
		}
	}
}

// parseQuery parses a URL query string into a map (first value wins).
func parseQuery(q string) map[string]string {
	out := make(map[string]string)
	for q != "" {
		part := q
		if i := strings.IndexByte(q, '&'); i >= 0 {
			part = q[:i]
			q = q[i+1:]
		} else {
			q = ""
		}
		if part == "" {
			continue
		}
		k, v := part, ""
		if i := strings.IndexByte(part, '='); i >= 0 {
			k, v = part[:i], part[i+1:]
		}
		out[urlUnescape(k)] = urlUnescape(v)
	}
	return out
}

// urlUnescape decodes %XX and + in a query component.
func urlUnescape(s string) string {
	if !strings.ContainsAny(s, "%+") {
		return s
	}
	var sb strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '+' {
			sb.WriteByte(' ')
		} else if c == '%' && i+2 < len(s) {
			hi := hexVal(s[i+1])
			lo := hexVal(s[i+2])
			if hi >= 0 && lo >= 0 {
				sb.WriteByte(byte(hi<<4 | lo))
				i += 2
			} else {
				sb.WriteByte(c)
			}
		} else {
			sb.WriteByte(c)
		}
	}
	return sb.String()
}

func hexVal(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
}

// listenAndServe starts the raw TCP server on the given address (use ":0" for
// an ephemeral port) and returns the listener. Each connection is served in
// its own goroutine.
func listenAndServe(addr string, dispatch dispatchFunc) (net.Listener, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go serveConn(conn, dispatch)
		}
	}()
	return ln, nil
}
