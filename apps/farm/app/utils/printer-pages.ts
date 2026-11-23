export async function collectPrinterPages<T>(
  fetchPage: (
    after?: string,
  ) => Promise<{ printers: T[]; nextAfter: string | null }>,
): Promise<T[]> {
  const printers: T[] = []
  let after: string | undefined
  do {
    const page = await fetchPage(after)
    printers.push(...page.printers)
    after = page.nextAfter ?? undefined
  } while (after)
  return printers
}
