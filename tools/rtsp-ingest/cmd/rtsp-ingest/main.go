// Copyright (c) Open3dFarmManager contributors. Licensed under the MIT license.
package main

import (
	"context"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"open3dfarm.local/rtsp-ingest/internal/ingest"
)

func main() {
	if run() != nil {
		_, _ = io.WriteString(os.Stderr, "rtsp-ingest: falha\n")
		os.Exit(1)
	}
}

func run() error {
	deadline := time.Now().Add(30 * time.Second)
	signals, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stopSignals()
	entry, cancelEntry := context.WithDeadline(signals, deadline)
	defer cancelEntry()
	input := os.Stdin
	output := os.Stdout
	control := os.NewFile(3, "control")
	defer input.Close()
	defer output.Close()
	if control == nil {
		return errFailure
	}
	defer control.Close()
	stopRead := context.AfterFunc(entry, func() { _ = input.Close() })
	raw, err := io.ReadAll(io.LimitReader(input, 2049))
	stopRead()
	if err != nil || len(raw) > 2048 || entry.Err() != nil {
		return errFailure
	}
	cfg, err := ingest.ValidateConfig(raw)
	if err != nil || cfg.Lease <= 0 {
		return errFailure
	}
	remaining := time.Until(deadline)
	if remaining <= 0 || entry.Err() != nil {
		return errFailure
	}
	if cfg.Lease > remaining {
		cfg.Lease = remaining
	}
	ctx, cancel := context.WithTimeout(entry, cfg.Lease)
	defer cancel()
	if ingest.Run(ctx, cfg, output, control) != nil {
		return errFailure
	}
	return nil
}

type failure struct{}

func (failure) Error() string { return "failed" }

var errFailure error = failure{}
