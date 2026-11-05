// SPDX-License-Identifier: MIT

// rtspfixture is a finite maintained-library synthetic test server.
package main

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net/netip"
	"os"
	"os/signal"
	"syscall"
	"time"

	"open3dfarm.local/rtsp-ingest/internal/rtspfixture"
)

var errFixtureCommand = errors.New("RTSP_FIXTURE_COMMAND")

// Three private bytes: version 1 and explicit big-endian TCP4 loopback port.
// The descriptor stays open after configuration; subsequent EOF cancels.
func readConfig(input io.Reader) (netip.AddrPort, error) {
	var config [3]byte
	if _, err := io.ReadFull(input, config[:]); err != nil || config[0] != 1 {
		return netip.AddrPort{}, errFixtureCommand
	}
	port := binary.BigEndian.Uint16(config[1:])
	if port == 0 {
		return netip.AddrPort{}, errFixtureCommand
	}
	return netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), port), nil
}

func writeFixed(output io.Writer, data []byte) error {
	n, err := output.Write(data)
	if err != nil || n != len(data) {
		return errFixtureCommand
	}
	return nil
}

func runV1(ctx context.Context, input io.Reader, output io.Writer) error {
	address, err := readConfig(input)
	if err != nil || ctx.Err() != nil {
		return errFixtureCommand
	}
	fixture, err := rtspfixture.StartAt(ctx, address)
	if err != nil {
		return errFixtureCommand
	}
	defer fixture.Close()
	var ready [8]byte
	copy(ready[:4], "RTF1")
	binary.BigEndian.PutUint16(ready[4:6], address.Port())
	if writeFixed(output, ready[:]) != nil {
		return errFixtureCommand
	}
	ended := make(chan error, 1)
	go func() {
		var extra [1]byte
		n, err := input.Read(extra[:])
		if n != 0 || err != io.EOF {
			ended <- errFixtureCommand
			return
		}
		ended <- nil
	}()
	played := fixture.Played()
	for {
		select {
		case <-played:
			played = nil
			if fixture.SendAU(9000, rtspfixture.HeaderAU()) != nil {
				return errFixtureCommand
			}
		case inputError := <-ended:
			fixture.Close()
			counts := fixture.Snapshot()
			// RTS1 + six uint32 counters: accepted/rejected/PLAY/AU/RTP/wire.
			var summary [28]byte
			copy(summary[:4], "RTS1")
			for index, value := range []uint32{counts.Accepted, counts.Rejected, counts.Plays, counts.AccessUnits, counts.Packets, counts.WireBytes} {
				binary.BigEndian.PutUint32(summary[4+index*4:8+index*4], value)
			}
			if writeFixed(output, summary[:]) != nil || inputError != nil || counts.Failed {
				return errFixtureCommand
			}
			return nil
		case <-ctx.Done():
			return errFixtureCommand
		case <-fixture.Closed():
			return errFixtureCommand
		}
	}
}

func main() {
	// Deadline begins before configuration, including a stalled private pipe.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		os.Stdin.Close()
		os.Stdout.Close()
	}()
	if len(os.Args) != 1 || run(ctx, os.Stdin, os.Stdout) != nil {
		// No source address, system error or credential is emitted.
		os.Stderr.WriteString("RTSP_FIXTURE_COMMAND\n")
		os.Exit(1)
	}
}
