package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	comicService, err := NewComicService()
	if err != nil {
		log.Fatal(err)
	}

	app := application.New(application.Options{
		Name:        "Komika",
		Description: "Cross-platform manga viewer",
		Services: []application.Service{
			application.NewService(comicService),
		},
		Assets: application.AssetOptions{
			Handler:    application.AssetFileServerFS(assets),
			Middleware: mediaMiddleware(comicService),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:          "Komika",
		Width:          1024,
		Height:         760,
		MinWidth:       800,
		MinHeight:      600,
		EnableFileDrop: true,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(26, 29, 33),
		URL:              "/",
	})

	win.OnWindowEvent(events.Common.WindowFilesDropped, func(event *application.WindowEvent) {
		files := event.Context().DroppedFiles()
		details := event.Context().DropTargetDetails()
		application.Get().Event.Emit("files-dropped", map[string]any{
			"files":   files,
			"details": details,
		})
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
