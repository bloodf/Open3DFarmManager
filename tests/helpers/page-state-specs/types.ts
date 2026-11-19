// SPDX-License-Identifier: MIT
import type { PageHarness } from '../page-harness'

/** Each spec registers vitest suites; `harness()` is ready inside `it`. */
export type RegisterStates = (harness: () => PageHarness) => void
