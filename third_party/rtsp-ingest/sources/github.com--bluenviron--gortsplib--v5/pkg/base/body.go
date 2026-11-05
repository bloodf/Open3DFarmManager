package base

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
)

const (
	rtspMaxBodySize = 128 * 1024
)

type body []byte

func (b *body) unmarshal(header Header, rb *bufio.Reader) error {
	return b.unmarshalWithLimits(header, rb, nil)
}

func (b *body) unmarshalWithLimits(header Header, rb *bufio.Reader, limits *ReadLimits) error {
	cls, ok := header["Content-Length"]
	if ok && len(cls) != 1 && limits != nil {
		return fmt.Errorf("duplicate Content-Length")
	}
	if !ok || len(cls) != 1 {
		*b = nil
		return nil
	}

	cl, err := strconv.ParseUint(cls[0], 10, 64)
	if err != nil {
		return fmt.Errorf("invalid Content-Length")
	}

	maxBody := rtspMaxBodySize
	if limits != nil {
		maxBody = limits.MaxBodyBytes
	}
	if cl > uint64(maxBody) {
		return fmt.Errorf("Content-Length exceeds %d (it's %d)",
			maxBody, cl)
	}

	*b = make([]byte, cl)
	n, err := io.ReadFull(rb, *b)
	if err != nil && n != len(*b) {
		return err
	}

	return nil
}

func (b body) marshalSize() int {
	return len(b)
}

func (b body) marshalTo(buf []byte) int {
	return copy(buf, b)
}

func (b body) marshal() []byte {
	buf := make([]byte, b.marshalSize())
	b.marshalTo(buf)
	return buf
}
