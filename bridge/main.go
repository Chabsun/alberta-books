// alberta-books-mcp: lets Claude Desktop (which talks to MCP servers over
// stdin/stdout) use the running Alberta Books app. Each JSON-RPC line read on
// stdin is posted to the app's local server (127.0.0.1 only) with the personal
// key from ALBERTA_BOOKS_TOKEN; each reply is written to stdout on one line.
//
// It is a separate console program because a Windows GUI executable (the
// Electron app) does not receive stdin/stdout pipes reliably.
//
// Environment (written into Claude Desktop's config by the app):
//
//	ALBERTA_BOOKS_TOKEN        personal key (abk_...)
//	ALBERTA_BOOKS_SERVER_INFO  path of ai-server.json, where the app writes its port
//	ALBERTA_BOOKS_APP          the app's executable, started if the app isn't running
//
// Only the standard library is used. Nothing but protocol messages is ever
// written to stdout; diagnostics go to stderr.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

const defaultPort = 47815

var tokenRe = regexp.MustCompile(`^abk_[\w-]{43}$`)

func logf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "[alberta-books] "+format+"\n", a...)
}

// serverURL reads the port the app is listening on (it can change when the app restarts).
func serverURL() string {
	port := defaultPort
	if path := os.Getenv("ALBERTA_BOOKS_SERVER_INFO"); path != "" {
		if data, err := os.ReadFile(path); err == nil {
			var info struct {
				Port int `json:"port"`
			}
			if json.Unmarshal(data, &info) == nil && info.Port > 0 && info.Port < 65536 {
				port = info.Port
			}
		}
	}
	return fmt.Sprintf("http://127.0.0.1:%d/mcp", port)
}

type bridge struct {
	token    string
	client   *http.Client
	out      *bufio.Writer
	launched bool
	timeout  time.Duration
}

func (b *bridge) launchApp() {
	app := os.Getenv("ALBERTA_BOOKS_APP")
	if app == "" || b.launched {
		return
	}
	b.launched = true
	logf("Alberta Books is not running; starting it.")
	cmd := exec.Command(app)
	cmd.Env = withoutToken(os.Environ())
	if err := cmd.Start(); err != nil {
		logf("could not start %s: %v", app, err)
		return
	}
	_ = cmd.Process.Release()
}

func withoutToken(env []string) []string {
	out := make([]string, 0, len(env))
	for _, e := range env {
		if !strings.HasPrefix(e, "ALBERTA_BOOKS_TOKEN=") {
			out = append(out, e)
		}
	}
	return out
}

// post forwards one message, starting the app and retrying while it comes up.
func (b *bridge) post(line []byte) (int, []byte, error) {
	deadline := time.Now().Add(b.timeout)
	for {
		req, err := http.NewRequest(http.MethodPost, serverURL(), bytes.NewReader(line))
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Authorization", "Bearer "+b.token)
		res, err := b.client.Do(req)
		if err == nil {
			body, readErr := io.ReadAll(io.LimitReader(res.Body, 64<<20))
			res.Body.Close()
			return res.StatusCode, body, readErr
		}
		b.launchApp()
		if time.Now().After(deadline) {
			return 0, nil, err
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func requestID(line []byte) (json.RawMessage, bool) {
	var m map[string]json.RawMessage
	if json.Unmarshal(line, &m) != nil {
		return nil, false
	}
	id, ok := m["id"]
	return id, ok
}

func (b *bridge) writeError(id json.RawMessage, code int, message string) {
	msg, _ := json.Marshal(message)
	fmt.Fprintf(b.out, `{"jsonrpc":"2.0","id":%s,"error":{"code":%d,"message":%s}}`+"\n", id, code, msg)
	b.out.Flush()
}

func (b *bridge) handle(line []byte) {
	id, hasID := requestID(line)
	status, body, err := b.post(line)
	switch {
	case err != nil:
		reason := "Could not reach Alberta Books. Open the app and turn on AI assistants."
		logf("%s (%v)", reason, err)
		if hasID {
			b.writeError(id, -32002, reason)
		}
	case status == http.StatusAccepted || (status == http.StatusOK && len(bytes.TrimSpace(body)) == 0):
		// Notification: no reply.
	case status == http.StatusOK:
		b.out.Write(bytes.ReplaceAll(bytes.ReplaceAll(bytes.TrimSpace(body), []byte("\r"), nil), []byte("\n"), nil))
		b.out.WriteByte('\n')
		b.out.Flush()
	default:
		reason := fmt.Sprintf("Alberta Books answered with HTTP %d.", status)
		if status == http.StatusUnauthorized {
			reason = "Alberta Books rejected the key. Reconnect Claude Desktop from Alberta Books → AI assistants."
		}
		logf("%s", reason)
		if hasID {
			b.writeError(id, -32001, reason)
		}
	}
}

func main() {
	token := os.Getenv("ALBERTA_BOOKS_TOKEN")
	if !tokenRe.MatchString(token) {
		logf("ALBERTA_BOOKS_TOKEN is missing or invalid. Connect Claude Desktop from Alberta Books → AI assistants.")
		os.Exit(2)
	}
	b := &bridge{
		token:   token,
		client:  &http.Client{Timeout: 10 * time.Minute},
		out:     bufio.NewWriter(os.Stdout),
		timeout: 30 * time.Second,
	}
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 0, 1<<20), 40<<20) // statements and receipts arrive as base64 inside one line
	for in.Scan() {
		line := bytes.TrimSpace(in.Bytes())
		if len(line) > 0 {
			b.handle(append([]byte(nil), line...))
		}
	}
	if err := in.Err(); err != nil {
		logf("reading stdin: %v", err)
		os.Exit(1)
	}
}
