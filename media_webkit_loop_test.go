package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestWebKitAndroidLoopFalseContinuesPast8s(t *testing.T) {
	if os.Getenv("KOMIKA_WEBKIT_E2E") != "1" {
		t.Skip("set KOMIKA_WEBKIT_E2E=1")
	}
	mb := "/usr/lib/x86_64-linux-gnu/webkitgtk-6.0/MiniBrowser"
	if _, err := os.Stat(mb); err != nil {
		t.Skip(err)
	}
	src := "/media/veracrypt1/video/7c27eeeacdf685a5b5ea445e9d65b10c1bb963739a744b5a6de2cd2b08d9e505.mp4"
	if _, err := os.Stat(src); err != nil {
		t.Skip(err)
	}
	svc := testService(t)
	if _, err := svc.openPath(src, false); err != nil {
		t.Fatal(err)
	}
	ps, err := svc.GetPageStream(0)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "log.txt")
	_ = os.WriteFile(logPath, nil, 0o600)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	mux := http.NewServeMux()
	mux.HandleFunc("/probe.html", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<!doctype html><meta charset=utf-8>
<video id=v controls muted playsinline autoplay preload=auto></video>
<script>
const v=document.getElementById('v');
v.loop=false;
const t0=performance.now();
const L=(m)=>fetch('/log',{method:'POST',body:m});
let last=0,max=0,restarts=0,ended=false;
v.addEventListener('ended',()=>{ended=true; L('ended ct='+v.currentTime);});
v.addEventListener('playing',()=>L('playing'));
v.addEventListener('timeupdate',()=>{
  const ct=v.currentTime;
  if(ct+0.45<last && last>0.5){ restarts++; L('RESTART ct='+ct+' from='+last); }
  if(ct>max) max=ct; last=ct;
});
v.src=%q;
v.play().catch(e=>L('rej '+e));
setTimeout(()=>{ L('DONE max='+max.toFixed(3)+' restarts='+restarts+' ended='+ended+' paused='+v.paused); }, 15000);
</script>`, ps.URL)
	})
	mux.HandleFunc("/log", func(w http.ResponseWriter, r *http.Request) {
		b := make([]byte, 4096)
		n, _ := r.Body.Read(b)
		f, _ := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0o600)
		if f != nil {
			_, _ = f.Write(append(b[:n], '\n'))
			_ = f.Close()
		}
		w.WriteHeader(204)
	})
	go http.Serve(ln, mux)
	cmd := exec.Command(mb, fmt.Sprintf("http://%s/probe.html", ln.Addr().String()))
	_ = cmd.Start()
	deadline := time.Now().Add(20 * time.Second)
	var log string
	for time.Now().Before(deadline) {
		b, _ := os.ReadFile(logPath)
		log = string(b)
		if strings.Contains(log, "DONE max=") {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}
	time.Sleep(300 * time.Millisecond)
	b, _ := os.ReadFile(logPath)
	log = string(b)
	t.Logf("%s", log)
	if !strings.Contains(log, "DONE max=") {
		t.Fatal("no DONE")
	}
	var max float64
	restarts := -1
	ended := false
	for _, line := range strings.Split(log, "\n") {
		if strings.Contains(line, "RESTART") {
			t.Errorf("%s", line)
		}
		if strings.Contains(line, "DONE max=") {
			for _, p := range strings.Fields(line) {
				if strings.HasPrefix(p, "max=") {
					max, _ = strconv.ParseFloat(strings.TrimPrefix(p, "max="), 64)
				}
				if strings.HasPrefix(p, "restarts=") {
					restarts, _ = strconv.Atoi(strings.TrimPrefix(p, "restarts="))
				}
				if strings.HasPrefix(p, "ended=") {
					ended = strings.TrimPrefix(p, "ended=") == "true"
				}
			}
		}
	}
	if max < 12 {
		t.Fatalf("max=%.3f want >=12 (continue past ~8s, not early stop)", max)
	}
	if restarts != 0 {
		t.Fatalf("restarts=%d", restarts)
	}
	if ended {
		t.Fatal("ended early")
	}
}

func TestWebKitAndroidLoopTrueRestarts(t *testing.T) {
	if os.Getenv("KOMIKA_WEBKIT_E2E") != "1" {
		t.Skip("set KOMIKA_WEBKIT_E2E=1")
	}
	mb := "/usr/lib/x86_64-linux-gnu/webkitgtk-6.0/MiniBrowser"
	if _, err := os.Stat(mb); err != nil {
		t.Skip(err)
	}
	src := "/media/veracrypt1/video/7c27eeeacdf685a5b5ea445e9d65b10c1bb963739a744b5a6de2cd2b08d9e505.mp4"
	if _, err := os.Stat(src); err != nil {
		t.Skip(err)
	}
	svc := testService(t)
	if _, err := svc.openPath(src, false); err != nil {
		t.Fatal(err)
	}
	ps, err := svc.GetPageStream(0)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "log.txt")
	_ = os.WriteFile(logPath, nil, 0o600)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	mux := http.NewServeMux()
	mux.HandleFunc("/probe.html", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<!doctype html><meta charset=utf-8>
<video id=v controls muted playsinline autoplay preload=auto></video>
<script>
const v=document.getElementById('v');
v.loop=true;
const L=(m)=>fetch('/log',{method:'POST',body:m});
let last=0,restarts=0,max=0;
v.addEventListener('timeupdate',()=>{
  const ct=v.currentTime;
  if(ct+0.45<last && last>0.5){ restarts++; L('RESTART ct='+ct+' from='+last); }
  if(ct>max) max=ct; last=ct;
});
v.src=%q;
v.play().catch(()=>{});
setTimeout(()=>L('DONE max='+max.toFixed(3)+' restarts='+restarts), 12000);
</script>`, ps.URL)
	})
	mux.HandleFunc("/log", func(w http.ResponseWriter, r *http.Request) {
		b := make([]byte, 4096)
		n, _ := r.Body.Read(b)
		f, _ := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0o600)
		if f != nil {
			_, _ = f.Write(append(b[:n], '\n'))
			_ = f.Close()
		}
		w.WriteHeader(204)
	})
	go http.Serve(ln, mux)
	cmd := exec.Command(mb, fmt.Sprintf("http://%s/probe.html", ln.Addr().String()))
	_ = cmd.Start()
	deadline := time.Now().Add(16 * time.Second)
	var log string
	for time.Now().Before(deadline) {
		b, _ := os.ReadFile(logPath)
		log = string(b)
		if strings.Contains(log, "DONE max=") {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}
	time.Sleep(300 * time.Millisecond)
	b, _ := os.ReadFile(logPath)
	log = string(b)
	t.Logf("%s", log)
	if !strings.Contains(log, "RESTART") && !strings.Contains(log, "restarts=1") {
		// accept restarts>=1 in DONE
		ok := false
		for _, p := range strings.Fields(log) {
			if strings.HasPrefix(p, "restarts=") {
				n, _ := strconv.Atoi(strings.TrimPrefix(p, "restarts="))
				if n >= 1 {
					ok = true
				}
			}
		}
		if !ok {
			t.Fatalf("expected restart with loop=true: %q", log)
		}
	}
}
