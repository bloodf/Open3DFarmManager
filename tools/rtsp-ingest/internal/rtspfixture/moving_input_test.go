// SPDX-License-Identifier: MIT

package rtspfixture

import (
 "bytes"
 "crypto/sha256"
 "encoding/binary"
 "io"
 "testing"
)

func movingRecord(timestamp uint64, key bool, data []byte) []byte {
 record := make([]byte, 16+len(data))
 binary.BigEndian.PutUint32(record[:4], uint32(12+len(data)))
 record[4] = 1
 if key { record[5] = 1 }
 binary.BigEndian.PutUint64(record[8:16], timestamp)
 copy(record[16:], data)
 return record
}

func movingIDR() []byte { return []byte{0,0,1,0x67,0x11,0,0,1,0x68,0x22,0,0,1,0x65,0x33} }

func TestMovingHeaderBounds(t *testing.T) {
 valid := []byte{1,0x48,0x7a,0,30,0,0}
 h, err := ReadMovingHeader(bytes.NewReader(valid))
 if err != nil || h.Port != 18554 || h.Frames != 30 { t.Fatal("valid header rejected") }
 for _, data := range [][]byte{nil, valid[:6], {2,0x48,0x7a,0,30,0,0}, {1,0,0,0,30,0,0}, {1,0x48,0x7a,0,0,0,0}, {1,0x48,0x7a,0,61,0,0}, {1,0x48,0x7a,0,30,0,1}} {
  if _, err := ReadMovingHeader(bytes.NewReader(data)); err == nil { t.Fatal("malformed header accepted") }
 }
 for _, count := range []uint16{0,61,65535} { if _, err := NewMovingInput(bytes.NewReader(nil), count); err == nil { t.Fatal("invalid count accepted") } }
 if _, err := NewMovingInput(nil, 1); err == nil { t.Fatal("nil input accepted") }
}

func TestMovingThirtySequentialCanonicalHashes(t *testing.T) {
 var input bytes.Buffer
 for i := uint64(0); i < 30; i++ { input.Write(movingRecord(i*100000, true, movingIDR())) }
 reader, err := NewMovingInput(&input, 30)
 if err != nil { t.Fatal(err) }
 canonical := []byte{0,0,0,1,0x67,0x11,0,0,0,1,0x68,0x22,0,0,0,1,0x65,0x33}
 want := sha256.Sum256(canonical)
 for i := 0; i < 30; i++ {
  frame, err := reader.ReadNext()
  if err != nil || frame.Timestamp90k != 9000+uint32(i)*9000 || frame.CanonicalBytes != len(canonical) || frame.CanonicalSHA256 != want || len(frame.NALUs) != 3 { t.Fatal("changed canonical frame") }
 }
 if _, err := reader.ReadNext(); err != io.EOF || input.Len() != 0 { t.Fatal("count boundary changed") }
}

func TestMovingRejectsMalformedAndLatchesFailure(t *testing.T) {
 for name, record := range map[string][]byte{
  "nonkey": movingRecord(0,false,movingIDR()),
  "timestamp": movingRecord(1,true,movingIDR()),
  "missing-parameters": movingRecord(0,true,[]byte{0,0,1,0x65,0x11}),
  "non-idr": movingRecord(0,true,[]byte{0,0,1,0x61,0x11}),
  "sei-only": movingRecord(0,true,[]byte{0,0,1,0x06,0x11}),
  "forbidden": movingRecord(0,true,[]byte{0,0,1,0xe5,0x11}),
  "annexb": movingRecord(0,true,[]byte{1,2,3}),
  "truncated": {0,0,0,20,1},
  "oversized-prefix": {0,4,0,13},
 } {
  t.Run(name,func(t *testing.T) {
   input := bytes.NewReader(append(record, movingRecord(0,true,movingIDR())...))
   reader, _ := NewMovingInput(input, 2)
   if _, err := reader.ReadNext(); err == nil { t.Fatal("invalid record accepted") }
   remaining := input.Len()
   if _, err := reader.ReadNext(); err == nil || input.Len() != remaining { t.Fatal("terminal input resumed") }
  })
 }
}

func TestMovingPacketAndNALBoundsBeforeEncoder(t *testing.T) {
 // Nine small NALs and a nine-fragment NAL are rejected without an encoder.
 nine := append([]byte{}, movingIDR()...)
 for i := 0; i < 6; i++ { nine = append(nine,0,0,1,0x06,0x11) }
 large := append([]byte{}, movingIDR()...)
 large = append(large,0,0,1,0x65)
 large = append(large, bytes.Repeat([]byte{0x55},8*(payloadLimit-2))...)
 for _, data := range [][]byte{nine,large} {
  reader, _ := NewMovingInput(bytes.NewReader(movingRecord(0,true,data)),1)
  if _, err := reader.ReadNext(); err == nil { t.Fatal("existing finite server bound exceeded") }
 }
 // Five fragments plus the two parameter NALs and one IDR still fit eight.
 fit := append([]byte{}, movingIDR()...)
 fit = append(fit,0,0,1,0x65)
 fit = append(fit,bytes.Repeat([]byte{0x55},4*(payloadLimit-2))...)
 reader, _ := NewMovingInput(bytes.NewReader(movingRecord(0,true,fit)),1)
 if _, err := reader.ReadNext(); err != nil { t.Fatal("valid finite packet budget rejected") }
}

func TestMovingOwnedBytesAndTimestampOrder(t *testing.T) {
 first := movingRecord(0,true,movingIDR())
 input := bytes.NewReader(append(first,movingRecord(100000,true,movingIDR())...))
 reader, _ := NewMovingInput(input,2)
 frame, err := reader.ReadNext()
 if err != nil { t.Fatal(err) }
 frame.NALUs[0][1] = 0x77
 next, err := reader.ReadNext()
 if err != nil || next.NALUs[0][1] != 0x11 || next.Timestamp90k != 18000 { t.Fatal("record ownership aliases next input") }
 duplicate, _ := NewMovingInput(bytes.NewReader(append(first,first...)),2)
 if _, err := duplicate.ReadNext(); err != nil { t.Fatal(err) }
 if _, err := duplicate.ReadNext(); err == nil { t.Fatal("duplicate timestamp accepted") }
}
