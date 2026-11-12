# SPDX-License-Identifier: MIT
# Derived development-only simulator image. Upstream virtual-klipper-printer
# (GPL-3.0) and simulavr (GPL-2.0) stay external; this file only rebuilds the
# simulavr sources already shipped in the pinned image and sets avrsim options.
#
# Why: the pinned image compiles simulavr without optimisation (-O0). On
# typical x86_64 hosts it then emulates the 20 MHz MCU at a few percent of
# real time, so the 93-request MCU identify cannot finish inside Klippy's
# fixed 5-second connect window. Unpaced emulation also changes speed with host
# load after the clock sync, which Klipper reports as "Timer too close".
# See docs/SIMULATOR-READINESS-RESULT.md.

FROM ghcr.io/mainsail-crew/virtual-klipper-printer@sha256:27ea11e767f08575eb1ddbeaa71ec26b19c7eea741882c2f102db6352c732b87 AS simulavr
USER root
# Reproducible toolchain: Debian snapshot at a fixed timestamp, exact package
# versions, and a hash-locked setuptools wheel. None of it reaches the runtime.
ARG DEBIAN_SNAPSHOT=20261101T000000Z
RUN rm -f /etc/apt/sources.list.d/* \
  && printf 'deb http://snapshot.debian.org/archive/debian/%s bookworm main\ndeb http://snapshot.debian.org/archive/debian/%s bookworm-updates main\ndeb http://snapshot.debian.org/archive/debian-security/%s bookworm-security main\n' \
    "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list \
  && apt-get -o Acquire::Check-Valid-Until=false update \
  && apt-get install -y --no-install-recommends \
    g++=4:12.2.0-3 make=4.3-4.1 cmake=3.25.1-1 swig=4.1.0-0.2 \
    gcc-avr=1:5.4.0+Atmel3.6.2-3 avr-libc=1:2.0.0+Atmel3.6.2-3 binutils-avr=2.26.20160125+Atmel3.6.2-4 \
  && rm -rf /var/lib/apt/lists/* \
  && printf 'setuptools==80.9.0 --hash=sha256:062d34222ad13e0cc312a4c02d73f059e86a4acbfbdea8f8f76b28c99f306922\n' > /tmp/requirements.txt \
  && python3 -m pip install --no-cache-dir --only-binary=:all: --require-hashes -r /tmp/requirements.txt \
  && rm /tmp/requirements.txt
USER printer
WORKDIR /home/printer/simulavr
# simulavr's generated makefiles are not parallel-safe; build serially.
RUN rm -rf build \
  && cmake -H. -Bbuild -DBUILD_PYTHON=ON -DCMAKE_BUILD_TYPE=Release \
  && cmake --build build \
  && grep -q -- '-O3' build/libsim/CMakeFiles/sim.dir/flags.make

FROM ghcr.io/mainsail-crew/virtual-klipper-printer@sha256:27ea11e767f08575eb1ddbeaa71ec26b19c7eea741882c2f102db6352c732b87
COPY --from=simulavr --chown=printer:printer /home/printer/simulavr/build /home/printer/simulavr/build
# Real-time pacing caps emulated MCU time at this fraction of wall time. It
# must stay below the slowest rate the emulator sustains under host load, so
# the MCU clock never speeds up after Klippy's clock sync.
ARG SIMULAVR_PACING_RATE=0.1
USER root
RUN echo "$SIMULAVR_PACING_RATE" | grep -Eq '^(0\.[0-9]*[1-9][0-9]*|1(\.0+)?)$' \
  || { echo "SIMULAVR_PACING_RATE must be a number in (0, 1]" >&2; exit 1; }
RUN sed -i "s|/home/printer/klipper/scripts/avrsim.py |&-r ${SIMULAVR_PACING_RATE} |" /etc/supervisor/supervisord.conf \
  && grep -q "avrsim.py -r ${SIMULAVR_PACING_RATE} " /etc/supervisor/supervisord.conf
USER printer
