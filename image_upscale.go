package main

import (
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"math"
	"os"
	"runtime"
	"strings"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	maxUpscaleSourcePixels = 100_000_000
	maxUpscaleDestPixels   = 8_388_608
	maxUpscaleDestSide     = 4096
	maxUpscaleCacheEntries = 5
	maxUpscaleCacheBytes   = 384 << 20
)

var (
	errUpscaleUnsupported = errors.New("page does not support host upscaling")
	errUpscaleBounds      = errors.New("invalid upscale bounds")
)

type upscaleCacheKey struct {
	generation uint64
	pageIndex  int
}

type upscaleCacheEntry struct {
	image    image.Image
	bytes    int64
	lastUsed uint64
}

type upscaleDecodeFlight struct {
	done  chan struct{}
	image image.Image
	err   error
}

// UpscaleRequest describes one viewport tile. Source coordinates are natural
// image pixels; destination dimensions are device pixels.
type UpscaleRequest struct {
	PageIndex    int     `json:"pageIndex"`
	Rendering    string  `json:"rendering"` // highQuality
	SourceX      float64 `json:"sourceX"`
	SourceY      float64 `json:"sourceY"`
	SourceWidth  float64 `json:"sourceWidth"`
	SourceHeight float64 `json:"sourceHeight"`
	DestWidth    int     `json:"destWidth"`
	DestHeight   int     `json:"destHeight"`
}

func initUpscaleState(s *ComicService) {
	if s.upscaleSem == nil {
		workers := runtime.NumCPU() - 1
		if workers < 1 {
			workers = 1
		}
		if workers > 2 {
			workers = 2
		}
		s.upscaleSem = make(chan struct{}, workers)
	}
	if s.upscaleDecoded == nil {
		s.upscaleDecoded = make(map[upscaleCacheKey]*upscaleCacheEntry)
	}
	if s.upscaleInflight == nil {
		s.upscaleInflight = make(map[upscaleCacheKey]*upscaleDecodeFlight)
	}
}

// GetUpscaledStream renders a high-quality still-image viewport tile on the
// bounded Go worker pool and returns it through the existing loopback HTTP path.
func (s *ComicService) GetUpscaledStream(req UpscaleRequest) (*PageStream, error) {
	initStreamState(s)
	initUpscaleState(s)
	if req.Rendering != "highQuality" {
		return nil, errUpscaleUnsupported
	}
	if req.DestWidth < 1 || req.DestHeight < 1 ||
		req.DestWidth > maxUpscaleDestSide || req.DestHeight > maxUpscaleDestSide ||
		int64(req.DestWidth)*int64(req.DestHeight) > maxUpscaleDestPixels {
		return nil, errUpscaleBounds
	}
	if !(req.SourceWidth > 0) || !(req.SourceHeight > 0) ||
		!isFinite(req.SourceX) || !isFinite(req.SourceY) ||
		!isFinite(req.SourceWidth) || !isFinite(req.SourceHeight) {
		return nil, errUpscaleBounds
	}

	slot, err := s.acquireSourceLease()
	if err != nil {
		return nil, err
	}
	defer s.releaseSourceLease(slot)
	if req.PageIndex < 0 || req.PageIndex >= slot.source.PageCount() {
		return nil, errPageOutOfRange
	}
	desc := slot.source.PageDescriptor(req.PageIndex)
	mime := strings.ToLower(strings.TrimSpace(desc.Mime))
	if !strings.HasPrefix(mime, "image/") || mime == "image/gif" {
		return nil, errUpscaleUnsupported
	}

	s.upscaleSem <- struct{}{}
	defer func() { <-s.upscaleSem }()

	ps, err := slot.source.StreamPage(req.PageIndex)
	if err != nil {
		return nil, err
	}
	src, err := s.decodeUpscalePage(slot, req.PageIndex, ps)
	if err != nil {
		return nil, err
	}

	srcRect, err := upscaleSourceRect(req, src.Bounds())
	if err != nil {
		return nil, err
	}
	dst := image.NewNRGBA(image.Rect(0, 0, req.DestWidth, req.DestHeight))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, srcRect, xdraw.Src, nil)

	tmp, err := os.CreateTemp("", "komika-upscale-*.png")
	if err != nil {
		return nil, err
	}
	tmpPath := tmp.Name()
	_ = tmp.Chmod(0o600)
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}
	if err := png.Encode(tmp, dst); err != nil {
		cleanup()
		return nil, fmt.Errorf("encode upscale tile: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return nil, err
	}
	info, err := os.Stat(tmpPath)
	if err != nil {
		_ = os.Remove(tmpPath)
		return nil, err
	}
	token, err := mintStreamToken()
	if err != nil {
		_ = os.Remove(tmpPath)
		return nil, err
	}

	s.mu.Lock()
	if s.active == nil || s.active.generation != slot.generation {
		s.mu.Unlock()
		_ = os.Remove(tmpPath)
		return nil, errNoActiveComic
	}
	if s.maxArchiveTempBytes > 0 && s.archiveTempBytes+info.Size() > s.maxArchiveTempBytes {
		s.mu.Unlock()
		_ = os.Remove(tmpPath)
		return nil, errArchiveTempCacheFull
	}
	s.archiveTempBytes += info.Size()
	s.streams[token] = &streamEntry{
		generation: slot.generation,
		path:       tmpPath,
		mime:       "image/png",
		modTime:    info.ModTime(),
		temporary:  true,
		ownedBytes: info.Size(),
	}
	s.mu.Unlock()

	url, err := s.mediaStreamURL(token)
	if err != nil {
		_ = s.ReleasePageStream(token)
		return nil, err
	}
	return &PageStream{URL: url, Token: token, Mime: "image/png"}, nil
}

func isFinite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}

func decodePageConfig(ps pageStream) (image.Config, error) {
	r, err := ps.open()
	if err != nil {
		return image.Config{}, err
	}
	defer r.Close()
	config, _, err := image.DecodeConfig(r)
	return config, err
}

func decodePageImage(ps pageStream) (image.Image, error) {
	r, err := ps.open()
	if err != nil {
		return nil, err
	}
	defer r.Close()
	decoded, _, err := image.Decode(r)
	return decoded, err
}

func (s *ComicService) decodeUpscalePage(slot *sourceSlot, pageIndex int, ps pageStream) (image.Image, error) {
	key := upscaleCacheKey{generation: slot.generation, pageIndex: pageIndex}

	s.mu.Lock()
	if cached := s.upscaleDecoded[key]; cached != nil {
		s.upscaleCacheClock++
		cached.lastUsed = s.upscaleCacheClock
		decoded := cached.image
		s.mu.Unlock()
		return decoded, nil
	}
	if flight := s.upscaleInflight[key]; flight != nil {
		s.mu.Unlock()
		<-flight.done
		return flight.image, flight.err
	}
	flight := &upscaleDecodeFlight{done: make(chan struct{})}
	s.upscaleInflight[key] = flight
	s.mu.Unlock()

	config, err := decodePageConfig(ps)
	if err != nil {
		err = fmt.Errorf("decode image config: %w", err)
	} else if config.Width < 1 || config.Height < 1 ||
		int64(config.Width)*int64(config.Height) > maxUpscaleSourcePixels {
		err = errUpscaleBounds
	}
	var decoded image.Image
	if err == nil {
		decoded, err = decodePageImage(ps)
		if err != nil {
			err = fmt.Errorf("decode image: %w", err)
		}
	}

	s.mu.Lock()
	delete(s.upscaleInflight, key)
	flight.image = decoded
	flight.err = err
	if err == nil && s.active != nil && s.active.generation == slot.generation {
		bounds := decoded.Bounds()
		size := int64(bounds.Dx()) * int64(bounds.Dy()) * 4
		if size <= maxUpscaleCacheBytes {
			s.upscaleCacheClock++
			s.upscaleDecoded[key] = &upscaleCacheEntry{
				image:    decoded,
				bytes:    size,
				lastUsed: s.upscaleCacheClock,
			}
			s.upscaleDecodedBytes += size
			s.evictUpscaleCacheLocked()
		}
	}
	close(flight.done)
	s.mu.Unlock()
	return decoded, err
}

func (s *ComicService) evictUpscaleCacheLocked() {
	for len(s.upscaleDecoded) > maxUpscaleCacheEntries || s.upscaleDecodedBytes > maxUpscaleCacheBytes {
		var oldestKey upscaleCacheKey
		var oldest *upscaleCacheEntry
		for key, entry := range s.upscaleDecoded {
			if oldest == nil || entry.lastUsed < oldest.lastUsed {
				oldestKey = key
				oldest = entry
			}
		}
		if oldest == nil {
			break
		}
		delete(s.upscaleDecoded, oldestKey)
		s.upscaleDecodedBytes -= oldest.bytes
	}
	if s.upscaleDecodedBytes < 0 {
		s.upscaleDecodedBytes = 0
	}
}

func (s *ComicService) invalidateUpscaleCacheLocked() {
	clear(s.upscaleDecoded)
	s.upscaleDecodedBytes = 0
}

func upscaleSourceRect(req UpscaleRequest, bounds image.Rectangle) (image.Rectangle, error) {
	x0 := max(bounds.Min.X, int(math.Floor(req.SourceX)))
	y0 := max(bounds.Min.Y, int(math.Floor(req.SourceY)))
	x1 := min(bounds.Max.X, int(math.Ceil(req.SourceX+req.SourceWidth)))
	y1 := min(bounds.Max.Y, int(math.Ceil(req.SourceY+req.SourceHeight)))
	if x1 <= x0 || y1 <= y0 {
		return image.Rectangle{}, errUpscaleBounds
	}
	return image.Rect(x0, y0, x1, y1), nil
}
