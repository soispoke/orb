import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { clearConnection, getApiUrl, isConnected, login, setApiUrl } from "../src/api";
import { Settings } from "../src/Settings";

afterEach(() => { clearConnection(); vi.unstubAllGlobals(); });

const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);

it("has no built-in backend: a fresh install starts without an API URL", () => {
  expect(getApiUrl()).toBe("");
  for (const file of sources(resolve(__dirname, "../src")))
    expect(readFileSync(file, "utf8"), file).not.toContain("agent-backend.thomas.md");
});

it.each(["", "agent-backend.example.com", "ftp://agent-backend.example.com"])("login refuses to send the password when the API URL is %j", async url => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  setApiUrl(url);
  await expect(login("secret")).rejects.toThrow("API URL");
  expect(fetcher).not.toHaveBeenCalled();
  expect(isConnected()).toBe(false);
});

it("logs in to the backend the user entered", async () => {
  const fetcher = vi.fn(async () => Response.json({ token: "jwt" }));
  vi.stubGlobal("fetch", fetcher);
  setApiUrl("https://agent-backend.example.com/");
  await login("secret");
  expect(fetcher).toHaveBeenCalledWith("https://agent-backend.example.com/api/auth/login", expect.objectContaining({ method: "POST" }));
  expect(isConnected()).toBe(true);
});

it("Settings asks for the API URL and sends nothing while none is set", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(() => <Settings />);
  const url = screen.getByPlaceholderText("https://agent-backend.example.com") as HTMLInputElement;
  expect(url.value).toBe("");
  const password = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  fireEvent.input(password, { target: { value: "secret" } });
  expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(password, { key: "Enter" });
  await screen.findByText("Enter your backend’s API URL before connecting.");
  await screen.findByText(/Not connected — connect in Settings → Backend/);
  expect(fetcher).not.toHaveBeenCalled();
});
