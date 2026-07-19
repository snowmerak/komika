package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"time"
)

// Loopback HTTP for media tokens.
// WebKitGTK/GStreamer fails on wails:// blob and often on wails:// media URIs
// (FormatError). Range-capable http://127.0.0.1 avoids that.

func (s *ComicService) ensureMediaHTTPServer() (string, error) {
	s.mu.Lock()
	if s.mediaHTTPErr != nil {
		err := s.mediaHTTPErr
		s.mu.Unlock()
		return "", err
	}
	if s.mediaHTTPBase != "" {
		base := s.mediaHTTPBase
		s.mu.Unlock()
		return base, nil
	}
	s.mu.Unlock()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		s.mu.Lock()
		s.mediaHTTPErr = fmt.Errorf("media http listen: %w", err)
		err = s.mediaHTTPErr
		s.mu.Unlock()
		return "", err
	}

	mux := http.NewServeMux()
	mux.HandleFunc(mediaPathPrefix, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Range")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		s.serveMedia(w, r)
	})
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()

	base := "http://" + ln.Addr().String()
	s.mu.Lock()
	// Another goroutine may have won; shut ours down if so.
	if s.mediaHTTPBase != "" {
		existing := s.mediaHTTPBase
		s.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_ = srv.Shutdown(ctx)
		cancel()
		_ = ln.Close()
		return existing, nil
	}
	s.mediaHTTPBase = base
	s.mediaHTTPSrv = srv
	s.mu.Unlock()
	return base, nil
}

func (s *ComicService) mediaStreamURL(token string) (string, error) {
	base, err := s.ensureMediaHTTPServer()
	if err != nil {
		return "", err
	}
	return base + mediaPathPrefix + token, nil
}

func (s *ComicService) shutdownMediaHTTP() {
	s.mu.Lock()
	srv := s.mediaHTTPSrv
	s.mediaHTTPSrv = nil
	s.mediaHTTPBase = ""
	s.mu.Unlock()
	if srv == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
