package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Opt-in GUI check: KOMIKA_WEBKIT_E2E=1 go test -run TestWebKitMediaTokenPlayback
// Uses only repo fixtures so CI/default `go test .` stays headless and deterministic.
func TestWebKitMediaTokenPlayback(t *testing.T) {
	if os.Getenv("KOMIKA_WEBKIT_E2E") != "1" {
		t.Skip("set KOMIKA_WEBKIT_E2E=1 to run WebKitGTK MiniBrowser playback E2E")
	}
	mb := "/usr/lib/x86_64-linux-gnu/webkitgtk-6.0/MiniBrowser"
	if _, err := os.Stat(mb); err != nil {
		t.Skip("MiniBrowser not installed")
	}
	if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		t.Skip("no display")
	}

	src := filepath.Join("testdata", "media-fixture", "8-video.mp4")
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	clip := filepath.Join(dir, "clip.mp4")
	if err := os.WriteFile(clip, data, 0o600); err != nil {
		t.Fatal(err)
	}

	svc := testService(t)
	if _, err := svc.openPath(clip, false); err != nil {
		t.Fatal(err)
	}
	if d := svc.active.source.PageDescriptor(0); d.Delivery != deliveryStream {
		t.Fatalf("delivery=%q want stream for all video", d.Delivery)
	}
	ps, err := svc.GetPageStream(0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(ps.URL, "http://127.0.0.1:") {
		t.Fatalf("want loopback URL got %q", ps.URL)
	}

	req, _ := http.NewRequest(http.MethodGet, ps.URL, nil)
	req.Header.Set("Range", "bytes=0-127")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent {
		t.Fatalf("range status %d", resp.StatusCode)
	}
	if !strings.HasPrefix(resp.Header.Get("Content-Range"), "bytes 0-127/") {
		t.Fatalf("content-range %q", resp.Header.Get("Content-Range"))
	}

	logPath := filepath.Join(dir, "wk.log")
	_ = os.WriteFile(logPath, nil, 0o600)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	mux := http.NewServeMux()
	mux.HandleFunc("/probe.html", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<!doctype html><meta charset=utf-8><pre id=l></pre>
<video id=v controls muted playsinline></video>
<script>
const v=document.getElementById('v');
const L=(m)=>{fetch('/log',{method:'POST',body:m}).catch(()=>{}); document.getElementById('l').textContent+=m+'\n';};
let last=0;
['loadedmetadata','playing','timeupdate','error','ended'].forEach(e=>v.addEventListener(e,()=>{
  if(e==='timeupdate'){ if(v.currentTime-last<0.15) return; last=v.currentTime; }
  let x=' ct='+v.currentTime.toFixed(2)+' w='+v.videoWidth;
  if(e==='error'){ const er=v.error; x+=' code='+(er&&er.code)+' msg='+(er&&er.message); }
  L(e+x);
}));
v.src=%q;
v.play().catch(e=>L('play_reject '+e));
setTimeout(()=>{ L('DONE ct='+v.currentTime+' err='+(v.error&&v.error.code)); }, 5000);
</script>`, ps.URL)
	})
	mux.HandleFunc("/log", func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 4096)
		n, _ := r.Body.Read(buf)
		f, _ := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0o600)
		if f != nil {
			_, _ = f.Write(append(buf[:n], '\n'))
			_ = f.Close()
		}
		w.WriteHeader(204)
	})
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	defer srv.Close()

	url := fmt.Sprintf("http://%s/probe.html", ln.Addr().String())
	cmd := exec.Command(mb, url)
	cmd.Env = os.Environ()
	_ = cmd.Start()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-time.After(7 * time.Second):
		_ = cmd.Process.Kill()
	case <-done:
	}

	logb, _ := os.ReadFile(logPath)
	log := string(logb)
	t.Logf("webkit log:\n%s", log)
	if !strings.Contains(log, "playing") && !strings.Contains(log, "loadedmetadata") {
		t.Fatalf("no playback events; log=%q", log)
	}
	if !strings.Contains(log, "timeupdate") && !strings.Contains(log, "ended") {
		t.Fatalf("no timeupdate/ended: %s", log)
	}
	if strings.Contains(log, "err=1") || strings.Contains(log, "err=2") || strings.Contains(log, "err=3") || strings.Contains(log, "err=4") {
		t.Fatalf("video.error set: %s", log)
	}
}
