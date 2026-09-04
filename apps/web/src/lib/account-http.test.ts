import { describe, expect, it } from "vitest";
import { readAccountCredentials, accountJsonError } from "./account-http";

function request(origin = "https://zhiwei.example", body: unknown = { username: "test-user", password: "test-password-long" }) {
  return new Request("https://zhiwei.example/api/account/bind", { method: "POST", headers: { host: "zhiwei.example", origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}
describe("account HTTP boundary", () => {
  it("accepts only same-origin JSON credentials", async () => {
    expect(await readAccountCredentials(request())).toMatchObject({ username: "test-user" });
    await expect(readAccountCredentials(request("https://another.example"))).rejects.toMatchObject({ status: 403 });
    await expect(readAccountCredentials(request("https://zhiwei.example", { username: "a".repeat(5000) }))).rejects.toMatchObject({ status: 400 });
  });
  it("does not disclose provider errors or secrets", async () => {
    const response = accountJsonError(new Error("postgres://internal secret-password"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret-password");
  });
});
