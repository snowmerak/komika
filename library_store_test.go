package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func fixedClock(t time.Time) func() time.Time {
	return func() time.Time { return t.UTC() }
}

func mustGet(t *testing.T, store *LibraryStore) LibraryState {
	t.Helper()
	st, err := store.Get()
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func writeLibraryJSON(t *testing.T, dir string, payload any) {
	t.Helper()
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "library.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestLibraryStoreAtomicReloadAndPolicies(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)
	store, err := newLibraryStoreAt(dir, fixedClock(now))
	if err != nil {
		t.Fatal(err)
	}

	// Empty by default.
	st := mustGet(t, store)
	if len(st.Recents) != 0 {
		t.Fatalf("expected empty, got %d", len(st.Recents))
	}
	if !st.Settings.SaveRecents || st.Settings.RetentionDays != 0 {
		t.Fatalf("default settings: %+v", st.Settings)
	}

	if err := store.UpsertOpen("/a", "A", sourceTypeArchive, 10, 0); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertOpen("/b", "B", sourceTypeFolder, 5, 2); err != nil {
		t.Fatal(err)
	}
	// Dedup + most recent first: reopening /a moves it to front.
	if err := store.UpsertOpen("/a", "A", sourceTypeArchive, 10, 3); err != nil {
		t.Fatal(err)
	}
	st = mustGet(t, store)
	if len(st.Recents) != 2 {
		t.Fatalf("dedup: got %d", len(st.Recents))
	}
	if st.Recents[0].Path != "/a" || st.Recents[0].CurrentPage != 3 {
		t.Fatalf("front: %+v", st.Recents[0])
	}
	if st.Recents[1].Path != "/b" {
		t.Fatalf("second: %+v", st.Recents[1])
	}

	// Progress update only.
	if err := store.SetProgress("/b", 4); err != nil {
		t.Fatal(err)
	}
	prog, err := store.ProgressFor("/b")
	if err != nil {
		t.Fatal(err)
	}
	if prog != 4 {
		t.Fatalf("progress for /b: %d", prog)
	}

	// Reload from disk.
	store2, err := newLibraryStoreAt(dir, fixedClock(now))
	if err != nil {
		t.Fatal(err)
	}
	st2 := mustGet(t, store2)
	if len(st2.Recents) != 2 || st2.Recents[0].CurrentPage != 3 || st2.Recents[1].CurrentPage != 4 {
		t.Fatalf("reload: %+v", st2.Recents)
	}
	if !st2.Settings.SaveRecents {
		t.Fatalf("settings not persisted: %+v", st2.Settings)
	}

	// 20-item trim.
	for i := 0; i < 25; i++ {
		p := filepath.Join("/item", t.Name(), string(rune('a'+i%26)), string(rune('0'+i%10)), string(rune(i)))
		if err := store.UpsertOpen(p, "T", sourceTypeFolder, 1, 0); err != nil {
			t.Fatal(err)
		}
	}
	if got := len(mustGet(t, store).Recents); got != maxRecents {
		t.Fatalf("trim: got %d want %d", got, maxRecents)
	}
}

func TestLibraryStoreMissingAndCorrupt(t *testing.T) {
	dir := t.TempDir()
	// Missing file: empty usable store.
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	st := mustGet(t, store)
	if len(st.Recents) != 0 {
		t.Fatal("expected empty on missing")
	}

	// Corrupt JSON.
	if err := os.WriteFile(filepath.Join(dir, "library.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	store2, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(mustGet(t, store2).Recents) != 0 {
		t.Fatal("expected empty on corrupt")
	}
}

func TestLibraryStoreRemoveMany(t *testing.T) {
	dir := t.TempDir()
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	_ = store.UpsertOpen("/x", "X", sourceTypeArchive, 1, 0)
	_ = store.UpsertOpen("/y", "Y", sourceTypeArchive, 1, 0)
	_ = store.UpsertOpen("/z", "Z", sourceTypeArchive, 1, 0)

	if err := store.RemoveMany([]string{"/x", "/missing", "/x", "/z"}); err != nil {
		t.Fatal(err)
	}
	st := mustGet(t, store)
	if len(st.Recents) != 1 || st.Recents[0].Path != "/y" {
		t.Fatalf("after remove: %+v", st.Recents)
	}
	// Empty paths is no-op.
	if err := store.RemoveMany(nil); err != nil {
		t.Fatal(err)
	}
	if err := store.RemoveMany([]string{}); err != nil {
		t.Fatal(err)
	}
}

func TestLibraryStoreLegacyMigrationAndInvalidRetention(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)
	// Legacy payload without settings.
	writeLibraryJSON(t, dir, map[string]any{
		"recents": []map[string]any{
			{
				"path":        "/legacy",
				"title":       "Legacy",
				"sourceType":  sourceTypeArchive,
				"pageCount":   3,
				"currentPage": 1,
				"lastOpened":  now.Format(time.RFC3339),
			},
		},
	})
	store, err := newLibraryStoreAt(dir, fixedClock(now))
	if err != nil {
		t.Fatal(err)
	}
	st := mustGet(t, store)
	if !st.Settings.SaveRecents || st.Settings.RetentionDays != 0 {
		t.Fatalf("migrated settings: %+v", st.Settings)
	}
	if len(st.Recents) != 1 || st.Recents[0].Path != "/legacy" {
		t.Fatalf("recents lost: %+v", st.Recents)
	}

	// Invalid retention normalizes to 0, preserves SaveRecents=false and clears recents.
	writeLibraryJSON(t, dir, map[string]any{
		"recents": []map[string]any{
			{
				"path":        "/keep",
				"title":       "Keep",
				"sourceType":  sourceTypeFolder,
				"pageCount":   1,
				"currentPage": 0,
				"lastOpened":  now.Format(time.RFC3339),
			},
		},
		"settings": map[string]any{
			"saveRecents":   false,
			"retentionDays": 15,
		},
	})
	store2, err := newLibraryStoreAt(dir, fixedClock(now))
	if err != nil {
		t.Fatal(err)
	}
	st2 := mustGet(t, store2)
	if st2.Settings.SaveRecents || st2.Settings.RetentionDays != 0 {
		t.Fatalf("invalid retention normalize: %+v", st2.Settings)
	}
	if len(st2.Recents) != 0 {
		t.Fatalf("disabled should clear: %+v", st2.Recents)
	}
}

func TestLibraryStoreTTLBoundaries(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)
	// 7-day retention: keep exactly cutoff and newer; drop older and malformed.
	writeLibraryJSON(t, dir, map[string]any{
		"settings": map[string]any{"saveRecents": true, "retentionDays": 7},
		"recents": []map[string]any{
			{"path": "/old", "title": "Old", "sourceType": sourceTypeArchive, "pageCount": 1, "currentPage": 0, "lastOpened": now.AddDate(0, 0, -8).Format(time.RFC3339)},
			{"path": "/edge", "title": "Edge", "sourceType": sourceTypeArchive, "pageCount": 1, "currentPage": 0, "lastOpened": now.AddDate(0, 0, -7).Format(time.RFC3339)},
			{"path": "/fresh", "title": "Fresh", "sourceType": sourceTypeArchive, "pageCount": 1, "currentPage": 0, "lastOpened": now.Add(-time.Minute).Format(time.RFC3339)},
			{"path": "/bad", "title": "Bad", "sourceType": sourceTypeArchive, "pageCount": 1, "currentPage": 0, "lastOpened": "not-a-date"},
		},
	})
	store, err := newLibraryStoreAt(dir, fixedClock(now))
	if err != nil {
		t.Fatal(err)
	}
	st := mustGet(t, store)
	if len(st.Recents) != 2 {
		t.Fatalf("ttl prune count: %+v", st.Recents)
	}
	paths := map[string]bool{}
	for _, r := range st.Recents {
		paths[r.Path] = true
	}
	if !paths["/edge"] || !paths["/fresh"] || paths["/old"] || paths["/bad"] {
		t.Fatalf("ttl paths: %+v", st.Recents)
	}

	// 0 retention never expires.
	writeLibraryJSON(t, dir, map[string]any{
		"settings": map[string]any{"saveRecents": true, "retentionDays": 0},
		"recents": []map[string]any{
			{"path": "/ancient", "title": "A", "sourceType": sourceTypeArchive, "pageCount": 1, "currentPage": 0, "lastOpened": now.AddDate(-1, 0, 0).Format(time.RFC3339)},
		},
	})
	store0, err := newLibraryStoreAt(dir, fixedClock(now))
	if err != nil {
		t.Fatal(err)
	}
	if len(mustGet(t, store0).Recents) != 1 {
		t.Fatal("retention 0 should keep ancient")
	}

	// 30-day prune via UpdateSettings.
	dir30 := t.TempDir()
	writeLibraryJSON(t, dir30, map[string]any{
		"settings": map[string]any{"saveRecents": true, "retentionDays": 0},
		"recents": []map[string]any{
			{"path": "/keep30", "title": "K", "sourceType": sourceTypeArchive, "pageCount": 1, "currentPage": 0, "lastOpened": now.AddDate(0, 0, -29).Format(time.RFC3339)},
			{"path": "/drop30", "title": "D", "sourceType": sourceTypeArchive, "pageCount": 1, "currentPage": 0, "lastOpened": now.AddDate(0, 0, -31).Format(time.RFC3339)},
			{"path": "/keep90", "title": "K9", "sourceType": sourceTypeArchive, "pageCount": 1, "currentPage": 0, "lastOpened": now.AddDate(0, 0, -89).Format(time.RFC3339)},
			{"path": "/drop90", "title": "D9", "sourceType": sourceTypeArchive, "pageCount": 1, "currentPage": 0, "lastOpened": now.AddDate(0, 0, -91).Format(time.RFC3339)},
		},
	})
	s30, err := newLibraryStoreAt(dir30, fixedClock(now))
	if err != nil {
		t.Fatal(err)
	}
	if err := s30.UpdateSettings(LibrarySettings{SaveRecents: true, RetentionDays: 30}); err != nil {
		t.Fatal(err)
	}
	st30 := mustGet(t, s30)
	got30 := map[string]bool{}
	for _, r := range st30.Recents {
		got30[r.Path] = true
	}
	if !got30["/keep30"] || got30["/drop30"] || got30["/keep90"] || got30["/drop90"] {
		t.Fatalf("30-day prune: %+v", st30.Recents)
	}
	if err := s30.UpdateSettings(LibrarySettings{SaveRecents: true, RetentionDays: 90}); err != nil {
		t.Fatal(err)
	}
	if mustGet(t, s30).Settings.RetentionDays != 90 {
		t.Fatal("90 not applied")
	}
}

func TestLibraryStoreDisabledBehavior(t *testing.T) {
	dir := t.TempDir()
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	_ = store.UpsertOpen("/a", "A", sourceTypeArchive, 5, 1)
	if err := store.UpdateSettings(LibrarySettings{SaveRecents: false, RetentionDays: 7}); err != nil {
		t.Fatal(err)
	}
	st := mustGet(t, store)
	if st.Settings.SaveRecents || len(st.Recents) != 0 {
		t.Fatalf("disable clear: %+v", st)
	}
	if err := store.UpsertOpen("/b", "B", sourceTypeArchive, 3, 0); err != nil {
		t.Fatal(err)
	}
	if err := store.SetProgress("/b", 2); err != nil {
		t.Fatal(err)
	}
	prog, err := store.ProgressFor("/b")
	if err != nil {
		t.Fatal(err)
	}
	if prog != 0 {
		t.Fatalf("disabled progress: %d", prog)
	}
	if len(mustGet(t, store).Recents) != 0 {
		t.Fatal("disabled upsert should not persist")
	}
	// Re-enable starts empty.
	if err := store.UpdateSettings(LibrarySettings{SaveRecents: true, RetentionDays: 7}); err != nil {
		t.Fatal(err)
	}
	if len(mustGet(t, store).Recents) != 0 {
		t.Fatal("re-enable should start empty")
	}
	if err := store.UpsertOpen("/c", "C", sourceTypeFolder, 2, 0); err != nil {
		t.Fatal(err)
	}
	if len(mustGet(t, store).Recents) != 1 {
		t.Fatal("re-enable should accept new opens")
	}
}

func TestLibraryStoreClearAndInvalidSettings(t *testing.T) {
	dir := t.TempDir()
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	_ = store.UpsertOpen("/a", "A", sourceTypeArchive, 1, 0)
	if err := store.Clear(); err != nil {
		t.Fatal(err)
	}
	if len(mustGet(t, store).Recents) != 0 {
		t.Fatal("clear failed")
	}
	if err := store.Clear(); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateSettings(LibrarySettings{SaveRecents: true, RetentionDays: 15}); err == nil {
		t.Fatal("expected invalid retention days")
	} else if err.Error() != "invalid retention days" {
		t.Fatalf("error text: %v", err)
	}
}

func TestLibraryStoreReadonlyNoWriteWhenUnchanged(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)
	// Current-format store, no migration needed.
	writeLibraryJSON(t, dir, map[string]any{
		"settings": map[string]any{"saveRecents": true, "retentionDays": 0},
		"recents": []map[string]any{
			{"path": "/a", "title": "A", "sourceType": sourceTypeArchive, "pageCount": 1, "currentPage": 0, "lastOpened": now.Format(time.RFC3339)},
		},
	})
	libPath := filepath.Join(dir, "library.json")
	if err := os.Chmod(libPath, 0o400); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Chmod(dir, 0o700)
		_ = os.Chmod(libPath, 0o600)
	})

	store, err := newLibraryStoreAt(dir, fixedClock(now))
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Get()
	if err != nil {
		t.Fatalf("Get should succeed without write: %v", err)
	}
	if len(st.Recents) != 1 {
		t.Fatalf("recents: %+v", st.Recents)
	}
}

func TestLibraryStorePendingRetry(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)
	// Legacy missing settings forces migration write.
	writeLibraryJSON(t, dir, map[string]any{
		"recents": []map[string]any{
			{"path": "/a", "title": "A", "sourceType": sourceTypeArchive, "pageCount": 1, "currentPage": 0, "lastOpened": now.Format(time.RFC3339)},
		},
	})
	libPath := filepath.Join(dir, "library.json")
	// Block writes: dir read-only after seed.
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	store, err := newLibraryStoreAt(dir, fixedClock(now))
	if err != nil {
		t.Fatal(err)
	}

	// Restore writability and ensure Get commits pending if any, or remains usable.
	_ = os.Chmod(dir, 0o700)
	_ = os.Chmod(libPath, 0o600)
	st, err := store.Get()
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Recents) != 1 {
		t.Fatalf("pending/get: %+v", st.Recents)
	}
	if !st.Settings.SaveRecents {
		t.Fatalf("settings: %+v", st.Settings)
	}

	// ProgressFor pending-prune retry.
	dir2 := t.TempDir()
	writeLibraryJSON(t, dir2, map[string]any{
		"settings": map[string]any{"saveRecents": true, "retentionDays": 7},
		"recents": []map[string]any{
			{"path": "/exp", "title": "E", "sourceType": sourceTypeArchive, "pageCount": 2, "currentPage": 1, "lastOpened": now.AddDate(0, 0, -8).Format(time.RFC3339)},
			{"path": "/ok", "title": "O", "sourceType": sourceTypeArchive, "pageCount": 2, "currentPage": 1, "lastOpened": now.Format(time.RFC3339)},
		},
	})
	if err := os.Chmod(dir2, 0o500); err != nil {
		t.Fatal(err)
	}
	s2, err := newLibraryStoreAt(dir2, fixedClock(now))
	if err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(dir2, 0o700)
	prog, err := s2.ProgressFor("/exp")
	if err != nil {
		t.Fatal(err)
	}
	// After prune, expired should be gone => 0.
	if prog != 0 {
		t.Fatalf("expired progress after prune: %d", prog)
	}
	progOK, err := s2.ProgressFor("/ok")
	if err != nil {
		t.Fatal(err)
	}
	if progOK != 1 {
		t.Fatalf("ok progress: %d", progOK)
	}
}

func TestLibraryStoreTransactionalWriteFailure(t *testing.T) {
	dir := t.TempDir()
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertOpen("/a", "A", sourceTypeArchive, 1, 0); err != nil {
		t.Fatal(err)
	}
	// Block subsequent writes.
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	err = store.UpsertOpen("/b", "B", sourceTypeArchive, 1, 0)
	if err == nil {
		// Some platforms still allow temp write in same dir; skip hard assert if no failure.
		t.Log("write did not fail under chmod; skipping failure assertion")
		return
	}
	// State must remain previous successful snapshot.
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.state.Recents) != 1 || store.state.Recents[0].Path != "/a" {
		t.Fatalf("state mutated on failed write: %+v", store.state.Recents)
	}
	if store.pending == nil {
		t.Fatal("expected pending candidate after failed write")
	}
}

func TestLibraryStoreConcurrency(t *testing.T) {
	dir := t.TempDir()
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	_ = store.UpsertOpen("/a", "A", sourceTypeArchive, 10, 0)

	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(3)
		go func(i int) {
			defer wg.Done()
			_ = store.SetProgress("/a", i%10)
		}(i)
		go func() {
			defer wg.Done()
			_, _ = store.Get()
		}()
		go func(i int) {
			defer wg.Done()
			_ = store.UpsertOpen("/a", "A", sourceTypeArchive, 10, i%10)
		}(i)
	}
	wg.Wait()
	st := mustGet(t, store)
	if len(st.Recents) == 0 {
		t.Fatal("empty after concurrency")
	}
}
