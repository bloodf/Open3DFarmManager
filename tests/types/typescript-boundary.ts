import { projectVersion } from '../../packages/shared/src/index.ts'

// Root typecheck must follow the real .ts source import and reject its misuse.
// @ts-expect-error The imported version is a string.
const numericVersion: number = projectVersion

// @ts-expect-error strictNullChecks must remain enabled.
const requiredString: string = undefined

const values: string[] = []
// @ts-expect-error noUncheckedIndexedAccess must remain enabled.
const firstValue: string = values[0]

// @ts-expect-error exactOptionalPropertyTypes must remain enabled.
const optionalValue: { value?: string } = { value: undefined }

void numericVersion
void requiredString
void firstValue
void optionalValue
