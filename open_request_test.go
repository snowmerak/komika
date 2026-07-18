package main

import "testing"

func TestIsAssociatedExt(t *testing.T) {
	t.Parallel()
	trueCases := []string{
		"book.cbz",
		"/tmp/a.ZIP",
		`C:\x.Pdf`,
		"note.MD",
		"pic.PnG",
		"clip.webm",
		"track.opus",
		"doc.markdown",
	}
	for _, path := range trueCases {
		if !isAssociatedExt(path) {
			t.Fatalf("expected associated: %q", path)
		}
	}
	falseCases := []string{
		"run.exe",
		"notes.txt",
		"archive.tar",
		"noext",
		"",
	}
	for _, path := range falseCases {
		if isAssociatedExt(path) {
			t.Fatalf("expected not associated: %q", path)
		}
	}
}

func TestFirstAssociatedPath(t *testing.T) {
	t.Parallel()
	if got := firstAssociatedPath(nil, ""); got != "" {
		t.Fatalf("empty args: got %q", got)
	}
	// Single arg that is itself a path (no executable to skip).
	if got := firstAssociatedPath([]string{`/comics/a.cbz`}, ""); got != `/comics/a.cbz` {
		t.Fatalf("single path arg: got %q", got)
	}
	// Executable + path.
	if got := firstAssociatedPath([]string{"/usr/bin/komika", "/comics/a.cbz"}, ""); got != "/comics/a.cbz" {
		t.Fatalf("exe+path: got %q", got)
	}
	// Relative with working dir.
	if got := firstAssociatedPath([]string{"komika", "rel/x.pdf"}, "/home/user"); got != "/home/user/rel/x.pdf" {
		t.Fatalf("relative join: got %q", got)
	}
	// Quoted path.
	if got := firstAssociatedPath([]string{"komika", `"/tmp/q.png"`}, ""); got != "/tmp/q.png" {
		t.Fatalf("quoted: got %q", got)
	}
	// Skip non-associated.
	if got := firstAssociatedPath([]string{"komika", "readme.txt", "book.cbz"}, ""); got != "book.cbz" {
		t.Fatalf("skip non-associated: got %q", got)
	}
	// None associated.
	if got := firstAssociatedPath([]string{"komika", "a.txt", "b.exe"}, ""); got != "" {
		t.Fatalf("none: got %q", got)
	}
}

func TestPendingOpenPathConsumeOnce(t *testing.T) {
	// Serial: mutates package-level pending buffer.
	openReqMu.Lock()
	pendingOpenPath = ""
	openReqMu.Unlock()

	requestOpenPath("/tmp/one.cbz")
	if got := consumePendingOpenPath(); got != "/tmp/one.cbz" {
		t.Fatalf("first consume: got %q", got)
	}
	if got := consumePendingOpenPath(); got != "" {
		t.Fatalf("second consume must be empty, got %q", got)
	}

	requestOpenPath("")
	if got := consumePendingOpenPath(); got != "" {
		t.Fatalf("empty request must not set pending, got %q", got)
	}

	requestOpenPath("  /tmp/two.pdf  ")
	if got := consumePendingOpenPath(); got != "/tmp/two.pdf" {
		t.Fatalf("trim: got %q", got)
	}
}
