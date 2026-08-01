package main

import (
	"encoding/binary"
	"io"
	"os"
)

// Only Linux desktop eagerly rewrites moov-at-end MP4/MOV files. WebKitGTK has
// historically stalled on those files even over a Range-capable HTTP stream.
// Chromium/WebView2 and WebKit on Apple platforms get the original stream first;
// the existing playback watchdog can still request a fallback remux if needed.
func shouldEagerFaststartRemux(goos string) bool {
	return goos == "linux"
}

// mp4MoovBeforeMdat reports whether an MP4/MOV has its moov atom before mdat
// (faststart). Files with moov at the end often stall WebKitGTK over HTTP until
// the whole file is scanned; phone camera exports commonly look like this.
func mp4MoovBeforeMdat(path string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()

	var sawMdat bool
	// Walk top-level boxes; stop once we know order.
	for {
		var hdr [8]byte
		if _, err := io.ReadFull(f, hdr[:]); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return false, nil
			}
			return false, err
		}
		size := uint64(binary.BigEndian.Uint32(hdr[0:4]))
		typ := string(hdr[4:8])
		headerSize := uint64(8)
		if size == 1 {
			var ext [8]byte
			if _, err := io.ReadFull(f, ext[:]); err != nil {
				return false, err
			}
			size = binary.BigEndian.Uint64(ext[:])
			headerSize = 16
		} else if size == 0 {
			// extends to EOF
			if typ == "moov" {
				return !sawMdat, nil
			}
			if typ == "mdat" {
				return false, nil
			}
			return false, nil
		}
		if size < headerSize {
			return false, nil
		}
		switch typ {
		case "moov":
			return !sawMdat, nil
		case "mdat":
			sawMdat = true
		}
		// seek to next box
		skip := int64(size - headerSize)
		if _, err := f.Seek(skip, io.SeekCurrent); err != nil {
			return false, err
		}
	}
}
