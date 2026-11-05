# Offline Spoolman inventory traversal

`parseSpoolmanSpoolInventory` now composes the existing strict spool-page parser into one complete observed traversal. It accepts supplied response strings and request metadata, derives expected offsets from prior pages, and returns projected items only when the whole sequence is complete. It makes no request, writes no files or upstream data, and does not implement persistent mirroring or authentication.

Every page uses one caller-supplied farm/service scope and page size. Page observations must have nondecreasing timestamps; the result records their interval. A short page ends the traversal; a full final page requires a following empty page. Missing, repeated, skipped, nonzero-initial and trailing offsets are rejected. Duplicate spool IDs are rejected across pages as well as within a page. Remote scope or secret-like fields remain excluded by the existing projection.

The entire operation fails without returning partial inventory if any later page is malformed or inconsistent. Budgets are 256 pages, 4 MiB of supplied JSON, 10,000 items, plus existing per-page/schema limits. Errors use fixed local codes and do not echo upstream content. These are explicit resource limits, not claims about the maximum size of a real farm.

This is a validated traversal, **not an atomic upstream snapshot**: Spoolman may change between requests, and unique IDs plus contiguous offsets cannot detect every omission caused by concurrent mutation. The supplied scope and timestamps are not authenticated by this function. Fetch scheduling, freshness policy, retries and production persistence remain unimplemented.

Synthetic tests cover completed/empty traversals, required terminal pages, duplicates across pages, invalid ordering/time/scope, remote-field exclusion, later-page failures and aggregate resource budgets. No Docker, network, real accounts or printers are involved.
