// SPDX-License-Identifier: MIT
//
// Bundled default Kobra X client identity.
//
// Provenance: this is Anycubic's own TLS client certificate and private key for
// "Anycubic Slicer Next" (subject CN=AnycubicSlicer, O=Anycubic). It is the
// single shared slicer identity that the Kobra X LAN MQTTS broker (port 9883)
// accepts; it is not a per-user or per-printer secret. The same certificate and
// key ship in Anycubic Slicer Next and are published by the owner's own
// GPL-3.0 OrcaSlicer plugin "kobracontrol"
// (https://github.com/bloodf/kobracontrol, src/kobracontrol/). They are bundled
// here, unmodified, only so Open3DFarmManager can interoperate with a Kobra X
// that the user owns, on the user's own network.
//
// Open3DFarmManager is independent and is NOT affiliated with, endorsed by or
// supported by Anycubic. "Anycubic", "Kobra" and "Anycubic Slicer" are
// trademarks of their respective owners. See THIRD_PARTY.md.
//
// A user-supplied certificate file or a local Anycubic Slicer Next installation
// overrides this default (see kobra-x-cert.ts). No GPL-licensed source from the
// upstream projects is copied into this MIT repository; only this vendor data
// file and the public LAN protocol facts are reused.

export const BUNDLED_KOBRA_CLIENT_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIEDTCCAvWgAwIBAgICAZAwDQYJKoZIhvcNAQEFBQAwgZsxCzAJBgNVBAYTAkNO
MRIwEAYDVQQIDAlHdWFuZ2RvbmcxETAPBgNVBAcMCFNoZW56aGVuMREwDwYDVQQK
DAhBbnljdWJpYzERMA8GA1UECwwIQW55Y3ViaWMxEzARBgNVBAMMCkFDIFJvb3Qg
Q0ExKjAoBgkqhkiG9w0BCQEWG2FueWN1YmljX2Nsb3VkQGFueWN1YmljLmNvbTAg
Fw0yMzA3MjAwMzI3NTFaGA8yMTIzMDcyMTAzMjc1MVowgZ8xCzAJBgNVBAYTAkNO
MRIwEAYDVQQIDAlHdWFuZ2RvbmcxETAPBgNVBAcMCFNoZW56aGVuMREwDwYDVQQK
DAhBbnljdWJpYzERMA8GA1UECwwIQW55Y3ViaWMxFzAVBgNVBAMMDkFueWN1Ymlj
U2xpY2VyMSowKAYJKoZIhvcNAQkBFhthbnljdWJpY19jbG91ZEBhbnljdWJpYy5j
b20wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDdoQ7g2F/yecfpdlqT
b8W/84r3vQ4ZEWx2PbSTBcGD55HmzJp2lwABHFHbn4CltT9YzoJWpOiVMHYnyPep
43tkNUIcGm7z0jrTD5djyYjVAzEitkNzJspKK/xcVmZe/V7Q3IAWXtzgWCd0YpVk
K3J0HqoqJvcTSnYe4VXxbIGwbpeYyji9W/DuG1M4Z+sFiPDWeR9xo5IXRU5ZwaTP
8OiCCLSBbeKgf0UFWTIZdJ1JXJ7efbbstZOjf5L9LhBIC0hLdL4jlMpF7r0ThecJ
cTx9Bnw/hhy+i32rJTRzZDIaLhKg/bka9ZrORZdxxQRiPoMjLjoxtr4+AUaeLWkI
ajSJAgMBAAGjUzBRMB0GA1UdDgQWBBRI4P3/uKdYYFPEcFIwYxdv1p9gETAfBgNV
HSMEGDAWgBQlkDqpFERfr3u1rR9gNbNKtgrHIjAPBgNVHRMBAf8EBTADAQH/MA0G
CSqGSIb3DQEBBQUAA4IBAQBP3ws80Y9eBR2lpjYP3rVvH8kA6+LnEXT4PpHj+fSw
jciaNskzpiwNvBy00m32ACR5YKlMUjevlQuyyw+LQbTUwAEOwyy9SDQpiXdjL6q3
SPQ4aB4A57nFXOGrthc/nb9yFcteWrZrKbwvVUu2vqU7U8n7lJKjhVuFRWSXS3SV
sPc9JZ21kpPYWKbGtfD6jUlW0Ip+PurLw9FrbVwnEcOMf/ezSlrH5c8mfJyo8pVk
aC/6PpReqijusOSRZ5oLyhPvtgddXseJFByun1Ud0CDlFA05nGGPmnVcXD+GMnHH
i6baCTeifwp5Jpdzv4imcCPvayKUNuX32vYNfNkWC/R5
-----END CERTIFICATE-----
`

export const BUNDLED_KOBRA_CLIENT_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDdoQ7g2F/yecfp
dlqTb8W/84r3vQ4ZEWx2PbSTBcGD55HmzJp2lwABHFHbn4CltT9YzoJWpOiVMHYn
yPep43tkNUIcGm7z0jrTD5djyYjVAzEitkNzJspKK/xcVmZe/V7Q3IAWXtzgWCd0
YpVkK3J0HqoqJvcTSnYe4VXxbIGwbpeYyji9W/DuG1M4Z+sFiPDWeR9xo5IXRU5Z
waTP8OiCCLSBbeKgf0UFWTIZdJ1JXJ7efbbstZOjf5L9LhBIC0hLdL4jlMpF7r0T
hecJcTx9Bnw/hhy+i32rJTRzZDIaLhKg/bka9ZrORZdxxQRiPoMjLjoxtr4+AUae
LWkIajSJAgMBAAECggEASwRkC9lRiLqN30kvWW5g6hsec8KrTfLm2pMCVy2AlgxB
B3VD51YvKzERyBwSKITT/1RPK9K/4xe3NrpAkmGsd3vLd8W+vorvXFePr7gct7VP
4Wb+J7D+keKXlg2sswRiHqI0PN45Nzq/iBaCaJiIMiPbB0+PHBl9J/Cv7XsD3tq+
9WKhvXf2g1g9GMrLaCCcWXWCqcu0LlbqJnw3yMnJLSltmyFTmlVLjDHM75bMVz97
4emQzOlnRN2yA5cWWCaM+mgjNM2aWwUsXBZzCgwSqSaj1QD4B/epCuDBORWHS9D6
jL15w8xjly9q8OS+4d6beR5h9GiPyMK4Ff2wXImCXQKBgQDwXxtrL+kVZrQ/qftj
24F3+QDN0j5Z3lUMTfZPn6ng/E/aBfn8KcWJHj2vYkKZdB5wOXJr56BYe3Hukzfp
QF0E2+g1WAGskF1mb/vVab54geox5Y6CA+ionRn2kcCwybVkktR/0JK2UV9Qjb/z
k1WU+RUhNrW/GDBqYulaadnR+wKBgQDsCf2/yKGPxj4pIvAtn5RFSlfscddgkSnc
ouBkDXEp5ta+5PGrlrdzS/F0vFhvBPbfbVJxVwRnM/Oqj8c0/bj7oc5RpPxirciO
AaovKVPTiORaviytnB2HgkflkJfy5vdXv4ZQahAV/UwtSmLwBshe+Ya68MAFrQRa
7M4z6k4QSwKBgQCm7OVVoofzXMeADsONrTpT3pA4XvD95/CYAuwyj2ah35Z0igH4
o+mSN3YO/eXSO1mIBdz4Inqv98o/K+2ABjqSzUSNBvjipb63DL2Oj0i+1zmUPR6i
G6TOs4r8OGvgWbOmjHEV8fpwskHG5ymONZsRQYjy79N3SY0V1GrJZwjlUQKBgD0x
AeWcP7YkMK09b4KEYk3sTgrwIGPafj3Cw+VsTrAMNhPbCoPvWLO9NmWLBmoRoWae
0sarRmry3vKSv5QPSsuBURl9aiiy4NFfwRzk2+R1Eq4rqy1+0XD152muKJZCJlFL
R6jFNlJdDkiXhjqvp3ZnvfPswfs2tXBU/8gZsA8tAoGBALXfc5m9I5R1l1zN7tpa
ncA0S3EKzqmuCc3KzlS6OS0e9Lz1MsmfEsvxvW3w4SrdfTbwQpEy9RNg89dlgPtc
rdId1QdN2eWPY5M4lz9n9EYdzi9ufoKAEYu2a0lP+qz690JwmL1Jx49bvQEn5Nu0
4swn72uwBRlhjAw46MF77SBQ
-----END PRIVATE KEY-----
`

/** The bundled Anycubic Slicer client identity used when no override is present. */
export function bundledKobraClientIdentity(): {
  certPem: string
  keyPem: string
} {
  return {
    certPem: BUNDLED_KOBRA_CLIENT_CERT_PEM,
    keyPem: BUNDLED_KOBRA_CLIENT_KEY_PEM,
  }
}
