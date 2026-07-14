package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestGetPageRequiresOpenAndRange(t *testing.T) {
	dir := t.TempDir()
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewComicServiceWithStore(store)

	if _, err := svc.GetPage(0); err != errNoActiveComic {
		t.Fatalf("want no active, got %v", err)
	}
	if err := svc.SetProgress(0); err != errNoActiveComic {
		t.Fatalf("want no active setprogress, got %v", err)
	}

	folder := makeFolderFixture(t)
	comic, err := svc.openPath(folder, false)
	if err != nil {
		t.Fatal(err)
	}
	if comic.PageCount != 4 {
		t.Fatalf("pagecount %d", comic.PageCount)
	}

	if _, err := svc.GetPage(-1); err != errPageOutOfRange {
		t.Fatalf("want oor, got %v", err)
	}
	if _, err := svc.GetPage(comic.PageCount); err != errPageOutOfRange {
		t.Fatalf("want oor, got %v", err)
	}
	if err := svc.SetProgress(99); err != errPageOutOfRange {
		t.Fatalf("want oor setprogress, got %v", err)
	}

	payload, err := svc.GetPage(0)
	if err != nil {
		t.Fatal(err)
	}
	if payload.Index != 0 || payload.Mime == "" || len(payload.Data) == 0 {
		t.Fatalf("payload: %+v", payload)
	}
	if len(comic.Pages) != comic.PageCount {
		t.Fatalf("pages metadata %d pageCount %d", len(comic.Pages), comic.PageCount)
	}

	if err := svc.SetProgress(2); err != nil {
		t.Fatal(err)
	}
	// Reopen restores progress.
	comic2, err := svc.openPath(folder, false)
	if err != nil {
		t.Fatal(err)
	}
	if comic2.CurrentPage != 2 {
		t.Fatalf("restored page: %d", comic2.CurrentPage)
	}
}

func TestConcurrentGetPageAndProgress(t *testing.T) {
	dir := t.TempDir()
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewComicServiceWithStore(store)
	folder := filepath.Join("testdata", "media-fixture")
	comic, err := svc.openPath(folder, false)
	if err != nil {
		t.Fatal(err)
	}
	if comic.PageCount < 2 {
		t.Fatalf("expected multi-page media fixture, got %d", comic.PageCount)
	}
	imgIdx, vidIdx := 0, comic.PageCount-1
	for i, p := range comic.Pages {
		if strings.HasPrefix(p.Mime, "image/") {
			imgIdx = i
			break
		}
	}
	for i, p := range comic.Pages {
		if strings.HasPrefix(p.Mime, "video/") {
			vidIdx = i
			break
		}
	}

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			idx := imgIdx
			if i%2 == 0 {
				idx = vidIdx
			}
			payload, err := svc.GetPage(idx)
			if err != nil {
				t.Errorf("GetPage(%d): %v", idx, err)
				return
			}
			if payload == nil || payload.Mime == "" || len(payload.Data) == 0 {
				t.Errorf("empty payload for %d", idx)
			}
		}(i)
		go func(i int) {
			defer wg.Done()
			_ = svc.SetProgress(i % comic.PageCount)
		}(i)
	}
	wg.Wait()
}

func TestOpenRecentRemovesMissing(t *testing.T) {
	dir := t.TempDir()
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewComicServiceWithStore(store)

	missing := filepath.Join(dir, "gone.cbz")
	_ = store.UpsertOpen(missing, "Gone", sourceTypeArchive, 3, 1)

	_, err = svc.OpenRecent(missing)
	if err == nil {
		t.Fatal("expected missing error")
	}
	st, err := store.Get()
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Recents) != 0 {
		t.Fatalf("stale should be removed: %+v", st.Recents)
	}
}

func TestOpenPathMissingDoesNotRemoveRecents(t *testing.T) {
	dir := t.TempDir()
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewComicServiceWithStore(store)

	missing := filepath.Join(dir, "gone.cbz")
	if err := store.UpsertOpen(missing, "Gone", sourceTypeArchive, 3, 1); err != nil {
		t.Fatal(err)
	}

	_, err = svc.OpenPath(missing)
	if err == nil {
		t.Fatal("expected missing path error")
	}
	st, err := store.Get()
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Recents) != 1 || st.Recents[0].Path != missing {
		t.Fatalf("OpenPath must not remove recents: %+v", st.Recents)
	}
}

func TestOpenPathStandaloneMedia(t *testing.T) {
	dir := t.TempDir()
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewComicServiceWithStore(store)

	pngPath := filepath.Join(dir, "solo.png")
	writePNG(t, pngPath, 0x22)

	comic, err := svc.OpenPath(pngPath)
	if err != nil {
		t.Fatal(err)
	}
	if comic.SourceType != sourceTypeMedia {
		t.Fatalf("source type: %q", comic.SourceType)
	}
	if comic.PageCount != 1 || comic.Title != "solo.png" {
		t.Fatalf("comic: %+v", comic)
	}
	if len(comic.Pages) != 1 || comic.Pages[0].Mime != "image/png" {
		t.Fatalf("pages: %+v", comic.Pages)
	}

	payload, err := svc.GetPage(0)
	if err != nil {
		t.Fatal(err)
	}
	if payload.Mime != "image/png" || len(payload.Data) == 0 {
		t.Fatalf("payload: %+v", payload)
	}

	st, err := svc.GetLibrary()
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Recents) != 1 || st.Recents[0].SourceType != sourceTypeMedia {
		t.Fatalf("recents: %+v", st.Recents)
	}
}

func TestOpenPathUnsupportedLooseFile(t *testing.T) {
	dir := t.TempDir()
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewComicServiceWithStore(store)

	path := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = svc.OpenPath(path)
	if err == nil {
		t.Fatal("expected unsupported error")
	}
	if !strings.Contains(err.Error(), "unsupported file type") {
		t.Fatalf("user-facing message: %v", err)
	}
}

func TestOpenPathEmptyRejected(t *testing.T) {
	dir := t.TempDir()
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewComicServiceWithStore(store)
	if _, err := svc.OpenPath(""); err == nil {
		t.Fatal("expected empty path error")
	}
}

func TestOpenRecentStaleCleanupPersistenceFailure(t *testing.T) {
	dir := t.TempDir()
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewComicServiceWithStore(store)

	missing := filepath.Join(dir, "gone.cbz")
	if err := store.UpsertOpen(missing, "Gone", sourceTypeArchive, 3, 1); err != nil {
		t.Fatal(err)
	}

	// Block writes so RemoveMany fails during stale cleanup.
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	_, err = svc.OpenRecent(missing)
	if err == nil {
		t.Fatal("expected persistence error from stale cleanup")
	}
	if err.Error() == "comic no longer exists: "+missing {
		t.Fatalf("want RemoveMany persistence error, got existence error: %v", err)
	}
	// Record remains until cleanup can persist.
	store.mu.Lock()
	n := len(store.state.Recents)
	store.mu.Unlock()
	if n != 1 {
		t.Fatalf("recents mutated without successful persist: %d", n)
	}
}

func TestServiceRecentManagementMethods(t *testing.T) {
	dir := t.TempDir()
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewComicServiceWithStore(store)

	_ = store.UpsertOpen("/a", "A", sourceTypeArchive, 3, 0)
	_ = store.UpsertOpen("/b", "B", sourceTypeFolder, 4, 1)
	_ = store.UpsertOpen("/c", "C", sourceTypeArchive, 5, 2)

	st, err := svc.RemoveRecents([]string{"/a", "/missing"})
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Recents) != 2 {
		t.Fatalf("remove: %+v", st.Recents)
	}
	// Empty paths no-op.
	st, err = svc.RemoveRecents(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Recents) != 2 {
		t.Fatalf("noop remove: %+v", st.Recents)
	}

	st, err = svc.UpdateLibrarySettings(LibrarySettings{SaveRecents: true, RetentionDays: 30})
	if err != nil {
		t.Fatal(err)
	}
	if st.Settings.RetentionDays != 30 {
		t.Fatalf("settings: %+v", st.Settings)
	}

	st, err = svc.ClearRecents()
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Recents) != 0 {
		t.Fatalf("clear: %+v", st.Recents)
	}

	if _, err := svc.UpdateLibrarySettings(LibrarySettings{SaveRecents: true, RetentionDays: 3}); err == nil {
		t.Fatal("expected invalid retention")
	}
}

func TestServiceDisabledOpenAndProgress(t *testing.T) {
	dir := t.TempDir()
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewComicServiceWithStore(store)
	folder := makeFolderFixture(t)

	if _, err := svc.UpdateLibrarySettings(LibrarySettings{SaveRecents: false, RetentionDays: 0}); err != nil {
		t.Fatal(err)
	}
	comic, err := svc.openPath(folder, false)
	if err != nil {
		t.Fatal(err)
	}
	if comic.CurrentPage != 0 {
		t.Fatalf("disabled open page: %d", comic.CurrentPage)
	}
	if err := svc.SetProgress(2); err != nil {
		t.Fatal(err)
	}
	// Reopen still starts at 0; no recents.
	comic2, err := svc.openPath(folder, false)
	if err != nil {
		t.Fatal(err)
	}
	if comic2.CurrentPage != 0 {
		t.Fatalf("disabled reopen page: %d", comic2.CurrentPage)
	}
	st, err := svc.GetLibrary()
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Recents) != 0 || st.Settings.SaveRecents {
		t.Fatalf("disabled library: %+v", st)
	}
}

func TestOpenPathPropagatesProgressForError(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)
	store, err := newLibraryStoreAt(dir, fixedClock(now))
	if err != nil {
		t.Fatal(err)
	}
	folder := makeFolderFixture(t)
	if err := store.UpsertOpen(folder, "F", sourceTypeFolder, 4, 2); err != nil {
		t.Fatal(err)
	}

	// Inject a pending candidate and block writes so ProgressFor fails before resume.
	store.mu.Lock()
	cand := cloneState(store.state)
	cand.Recents = []RecentComic{}
	store.pending = &cand
	store.mu.Unlock()

	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	svc := NewComicServiceWithStore(store)
	_, err = svc.openPath(folder, false)
	if err == nil {
		t.Log("openPath did not error; write may have succeeded on this FS")
		return
	}
	// Active source must not be left open after progress error (src closed before return).
	svc.mu.Lock()
	active := svc.active
	svc.mu.Unlock()
	if active != nil {
		// openPath only promotes a slot after ProgressFor succeeds, so active should be nil
		// unless a prior open existed. Ensure no leaked assignment from this call.
		t.Fatalf("source assigned despite ProgressFor error")
	}
}

func TestServiceConcurrentSettingsAndRemoval(t *testing.T) {
	dir := t.TempDir()
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewComicServiceWithStore(store)
	folder := makeFolderFixture(t)
	comic, err := svc.openPath(folder, false)
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(3)
		go func(i int) {
			defer wg.Done()
			_ = svc.SetProgress(i % comic.PageCount)
		}(i)
		go func() {
			defer wg.Done()
			_, _ = svc.UpdateLibrarySettings(LibrarySettings{SaveRecents: true, RetentionDays: 30})
		}()
		go func() {
			defer wg.Done()
			_, _ = svc.RemoveRecents([]string{"/nope"})
		}()
	}
	wg.Wait()
}
