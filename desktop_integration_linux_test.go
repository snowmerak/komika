//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDesktopIntegrationInstallRemove(t *testing.T) {
	home := t.TempDir()
	xdg := filepath.Join(home, "xdg-data")
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", xdg)
	t.Setenv("APPIMAGE", "")

	// Point executable resolution at a real temp file via APPIMAGE.
	bin := filepath.Join(home, "Komika.AppImage")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("APPIMAGE", bin)

	before, err := getDesktopIntegration()
	if err != nil {
		t.Fatal(err)
	}
	if !before.Supported {
		t.Fatal("expected supported on linux")
	}
	if before.Installed {
		t.Fatal("expected not installed initially")
	}
	if before.ExecPath != bin {
		t.Fatalf("exec path: got %q want %q", before.ExecPath, bin)
	}

	st, err := installDesktopIntegration()
	if err != nil {
		t.Fatal(err)
	}
	if !st.Installed {
		t.Fatalf("expected installed: %+v", st)
	}
	if st.ExecPath != bin {
		t.Fatalf("install exec: got %q want %q", st.ExecPath, bin)
	}

	desktopBytes, err := os.ReadFile(st.DesktopPath)
	if err != nil {
		t.Fatal(err)
	}
	desktop := string(desktopBytes)
	for _, want := range []string{
		"Name=Komika",
		"MimeType=",
		"application/vnd.comicbook+zip",
		"application/zip",
		"image/png",
		"application/pdf",
		"Categories=Graphics;Viewer;",
		"Exec=" + bin + " %F",
	} {
		if !strings.Contains(desktop, want) {
			t.Fatalf("desktop missing %q\n%s", want, desktop)
		}
	}
	if strings.Contains(desktop, "Comment=") {
		t.Fatalf("desktop must not set Comment (Open With may show it as the app name):\n%s", desktop)
	}

	mimeBytes, err := os.ReadFile(st.MimePath)
	if err != nil {
		t.Fatal(err)
	}
	mime := string(mimeBytes)
	for _, want := range []string{`pattern="*.cbz"`, `pattern="*.cbr"`, `pattern="*.cb7"`} {
		if !strings.Contains(mime, want) {
			t.Fatalf("mime missing %q\n%s", want, mime)
		}
	}
	for _, bad := range []string{`pattern="*.zip"`, `pattern="*.pdf"`, `pattern="*.png"`, "image/jpeg"} {
		if strings.Contains(mime, bad) {
			t.Fatalf("mime must not contain %q\n%s", bad, mime)
		}
	}

	iconPath := filepath.Join(xdg, iconRelPath)
	if _, err := os.Stat(iconPath); err != nil {
		t.Fatalf("icon missing: %v", err)
	}

	// Simulate moved AppImage → Get should warn.
	moved := filepath.Join(home, "moved.AppImage")
	if err := os.WriteFile(moved, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("APPIMAGE", moved)
	got, err := getDesktopIntegration()
	if err != nil {
		t.Fatal(err)
	}
	if !got.Installed {
		t.Fatal("still installed after move")
	}
	if !strings.Contains(got.Detail, "re-install recommended") {
		t.Fatalf("expected re-install detail, got %q", got.Detail)
	}

	// Restore APPIMAGE for remove path resolution.
	t.Setenv("APPIMAGE", bin)
	after, err := removeDesktopIntegration()
	if err != nil {
		t.Fatal(err)
	}
	if after.Installed {
		t.Fatalf("expected not installed after remove: %+v", after)
	}
	for _, p := range []string{st.DesktopPath, st.MimePath, iconPath} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("expected removed %s: %v", p, err)
		}
	}
}

func TestQuoteDesktopExec(t *testing.T) {
	t.Parallel()
	if got := quoteDesktopExec("/opt/komika"); got != "/opt/komika" {
		t.Fatalf("plain: %q", got)
	}
	got := quoteDesktopExec(`/opt/My Apps/komika`)
	if got != `"/opt/My Apps/komika"` {
		t.Fatalf("spaced: %q", got)
	}
}

func TestParseDesktopExec(t *testing.T) {
	t.Parallel()
	body := buildDesktopEntry(`/opt/My Apps/komika`)
	if got := parseDesktopExec(body); got != `/opt/My Apps/komika` {
		t.Fatalf("parse quoted: %q\n%s", got, body)
	}
	body2 := buildDesktopEntry(`/usr/bin/komika`)
	if got := parseDesktopExec(body2); got != `/usr/bin/komika` {
		t.Fatalf("parse plain: %q", got)
	}
}
