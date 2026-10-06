import { describe, expect, test } from "bun:test"
import { SESSION_RESULT_JSON_SCHEMA, SessionResult } from "../../src/agent/result.ts"

describe("the session result's JSON schema", () => {
  test("is strict and asks for exactly the fields SessionResult decodes", () => {
    expect(SESSION_RESULT_JSON_SCHEMA.additionalProperties).toBe(false)
    const keys = (record: object): Array<string> => Object.keys(record).sort()
    const required: ReadonlyArray<string> = SESSION_RESULT_JSON_SCHEMA.required
    expect([...required].sort()).toEqual(keys(SESSION_RESULT_JSON_SCHEMA.properties))
    expect(keys(SESSION_RESULT_JSON_SCHEMA.properties)).toEqual(keys(SessionResult.fields))
  })
})
