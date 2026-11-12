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

FROM ghcr.io/mainsail-crew/virtual-klipper-printer@sha256:c2ab1d20a3f6d9dda182bf69a078c5f37a066a44f1f34ffea48d49ddf7bbce47 AS simulavr
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends g++ make cmake swig gcc-avr avr-libc binutils-avr \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m pip install --no-cache-dir setuptools==80.9.0
USER printer
WORKDIR /home/printer/simulavr
# simulavr's generated makefiles are not parallel-safe; build serially.
RUN rm -rf build \
  && cmake -H. -Bbuild -DBUILD_PYTHON=ON -DCMAKE_BUILD_TYPE=Release \
  && cmake --build build \
  && grep -q -- '-O3' build/libsim/CMakeFiles/sim.dir/flags.make

FROM ghcr.io/mainsail-crew/virtual-klipper-printer@sha256:c2ab1d20a3f6d9dda182bf69a078c5f37a066a44f1f34ffea48d49ddf7bbce47
COPY --from=simulavr --chown=printer:printer /home/printer/simulavr/build /home/printer/simulavr/build
# Real-time pacing caps emulated MCU time at this fraction of wall time. It
# must stay below the slowest rate the emulator sustains under host load, so
# the MCU clock never speeds up after Klippy's clock sync.
ARG SIMULAVR_PACING_RATE=0.1
USER root
RUN sed -i "s|/home/printer/klipper/scripts/avrsim.py |&-r ${SIMULAVR_PACING_RATE} |" /etc/supervisor/supervisord.conf \
  && grep -q "avrsim.py -r ${SIMULAVR_PACING_RATE} " /etc/supervisor/supervisord.conf
USER printer
