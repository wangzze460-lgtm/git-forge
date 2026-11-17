// Entry point: connect this server to the trial harness, then wait for it to finish.
//
// The harness tells us where it lives through MAKEFUN_ENV_URL. We start our own
// server on a port the OS picks for us, tell the harness that port, and then keep
// asking it whether the trial is over. When it says yes, we shut down cleanly.
// Nothing else in the program talks to the harness — this file owns that handshake.

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

// The harness origin, with any trailing slashes trimmed off.
var harness = strings.TrimRight(os.Getenv("MAKEFUN_ENV_URL"), "/")

// Longest we let one register or poll request run before giving up on it.
const attemptTimeout = 30 * time.Second

// Backoff between retries: start here, double each time, never go past the cap.
const backoffStart = 250 * time.Millisecond
const backoffCap = 2 * time.Second

// backoffMs: exponential growth from backoffStart, capped.
func backoffMs(failures int) time.Duration {
	if failures > 8 {
		failures = 8
	}
	d := backoffStart
	for i := 0; i < failures; i++ {
		d *= 2
	}
	if d > backoffCap {
		return backoffCap
	}
	return d
}

var httpClient = &http.Client{Timeout: attemptTimeout}

// announce tells the harness which port we are listening on. 200 means it
// heard us; 409 means another entry got there first, which is fine — we just
// keep waiting for the trial to end. 400/405 mean we spoke the wrong protocol,
// so there is no point retrying. Anything else is retried.
func announce(port int) error {
	for failures := 0; ; failures++ {
		body, _ := json.Marshal(map[string]int{"port": port})
		req, err := http.NewRequest("POST", harness+"/register", bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("content-type", "application/json")
		res, err := httpClient.Do(req)
		if err == nil {
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
			if res.StatusCode == 200 || res.StatusCode == 409 {
				return nil
			}
			if res.StatusCode == 400 || res.StatusCode == 405 {
				return fmt.Errorf("register rejected with HTTP %d", res.StatusCode)
			}
		}
		time.Sleep(backoffMs(failures))
	}
}

// waitUntilDone asks the harness over and over until it reports the trial is finished.
func waitUntilDone() {
	for failures := 0; ; failures++ {
		req, err := http.NewRequest("GET", harness+"/done", nil)
		if err == nil {
			res, err := httpClient.Do(req)
			if err == nil {
				var body struct {
					Done bool `json:"done"`
				}
				_ = json.NewDecoder(res.Body).Decode(&body)
				res.Body.Close()
				if res.StatusCode >= 200 && res.StatusCode < 300 && body.Done {
					return
				}
			}
		}
		time.Sleep(backoffMs(failures))
	}
}

// run starts the server, registers with the harness, waits for the trial to end.
func run() error {
	srv := newServer()
	ln, err := listenAndServe("127.0.0.1:0", srv.dispatch)
	if err != nil {
		return err
	}
	addr := ln.Addr().(*net.TCPAddr)
	fmt.Fprintf(os.Stdout, "[entry] serving on port %d\n", addr.Port)
	if err := announce(addr.Port); err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, "[entry] registered with the harness")
	waitUntilDone()
	ln.Close()
	fmt.Fprintln(os.Stdout, "[entry] trial done, shutting down")
	return nil
}

func main() {
	if harness == "" {
		// Local test mode (no harness): listen on $FORGE_PORT (default 18099)
		// and serve until killed. The harness path is used when
		// MAKEFUN_ENV_URL is set.
		port := os.Getenv("FORGE_PORT")
		if port == "" {
			port = "18099"
		}
		srv := newServer()
		ln, err := listenAndServe("127.0.0.1:"+port, srv.dispatch)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[entry] %v\n", err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stdout, "[entry] serving on port %s (test mode)\n", port)
		// Block forever.
		select {}
		_ = ln
	}
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "[entry] %v\n", err)
		os.Exit(1)
	}
	os.Exit(0)
}
