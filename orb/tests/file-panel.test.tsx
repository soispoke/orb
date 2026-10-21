import {createSignal,useContext} from "solid-js";
import {FileReferenceContext,type ReferenceResolver} from "../src/fileReferenceContext";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { it, expect, vi } from "vitest";
import { FilePanelProvider, FilePanelButton } from "../src/FilePanel";
import { MdView } from "../src/Markdown";
import { api } from "../src/api";
import { fileScopeKey } from "../src/fileResources";
vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  // This fixture has no controller; never let optional source discovery hit
  // the real API and make reference resolution depend on network latency.
  getProjectController: vi.fn(async () => ({ settings: {} })),
  getProjectCron: vi.fn(async () => ({ settings: {} })),
  api: vi.fn(async (_path: string, init: RequestInit) => {
    const q = JSON.parse(String(init.body));
    if (q.action === "roots")
      return {
        sources: [{ id: "workspace", label: "Workspace", available: true }],
      };
    if (q.action === "list")
      return { entries: [{ name: "note.md", path: "note.md", kind: "file" }] };
    if (q.action === "resolve")
      return {
        results: q.paths.map((reference: string) => ({
          reference,
          matches:
            reference === "note.md"
              ? [{ name: "note.md", path: "note.md", kind: "file" }]
              : [],
        })),
      };
    if (q.action === "read")
      return {
        content: "# Readable note\n\nEvidence.",
        size: 27,
        binary: false,
        truncated: false,
      };
    return { entries: [] };
  }),
}));
it("opens a detected reference beside a mounted chat and switches Markdown with the focused shortcut", async () => {
  const { container, getByRole, getByText } = render(() => (
    <div class="app">
      <FilePanelProvider scope={{ project: "test" }}>
        <div class="chat">
          <input aria-label="Draft" value="keep this" />
          <MdView text="Read `note.md`." />
          <FilePanelButton />
        </div>
      </FilePanelProvider>
    </div>
  ));
  await waitFor(() =>
    expect(container.querySelector(".file-reference")).not.toBeNull(),
  );
  const draft = getByRole("textbox", { name: "Draft" });
  fireEvent.click(container.querySelector(".file-reference")!);
  await waitFor(() => expect(getByText("Readable note")).toBeTruthy());
  expect(getByRole("textbox", { name: "Draft" })).toBe(draft);
  const panel = container.querySelector<HTMLElement>(".file-panel")!;
  panel.focus();
  fireEvent.keyDown(window, { key: "/", metaKey: true });
  expect(container.querySelector(".file-source-code")).not.toBeNull();
  fireEvent.click(getByRole("button", { name: "Close files" }));
  expect(container.querySelector(".file-panel")).toBeNull();
  expect(draft).toHaveProperty("value", "keep this");
});

it("only resolves completed assistant text and updates changed references", async () => {
  const { createSignal } = await import("solid-js");
  const { Transcript } = await import("../src/Transcript");
  const { FileReferenceContext, FileReference } =
    await import("../src/fileReferenceContext");
  const resolve = vi.fn(async (raw: string) => [
    { source: "workspace", path: raw, name: raw, kind: "file" },
  ]);
  const [live, setLive] = createSignal(true);
  const [raw, setRaw] = createSignal("first.md");
  const { container } = render(() => (
    <FileReferenceContext.Provider
      value={{ resolve, open: () => {}, search: () => {} }}
    >
      <Transcript
        items={[{ kind: "text", text: "Read `note.md`.", live: live() }]}
      />
      <FileReference raw={raw()} />
    </FileReferenceContext.Provider>
  ));
  await waitFor(() => expect(resolve).toHaveBeenCalledWith("first.md"));
  expect(resolve).not.toHaveBeenCalledWith("note.md");
  setLive(false);
  await waitFor(() => expect(resolve).toHaveBeenCalledWith("note.md"));
  setRaw("second.md");
  await waitFor(() => expect(resolve).toHaveBeenCalledWith("second.md"));
  await waitFor(() =>
    expect(
      container.querySelector('[title="workspace: second.md"]'),
    ).not.toBeNull(),
  );
});

it("reschedules file lookups after a scope change cancels a pending batch",async()=>{
 const [project,setProject]=createSignal('before');
 let resolver!:ReferenceResolver;
 const Capture=()=>{resolver=useContext(FileReferenceContext)!;return null;};
 render(()=><FilePanelProvider scope={{project:project()}}><Capture/></FilePanelProvider>);
 const old=resolver.resolve('note.md');
 setProject('after');
 expect(await old).toEqual([]);
 const fresh=await resolver.resolve('note.md');
 expect(fresh).toEqual([expect.objectContaining({name:'note.md',source:'workspace'})]);
});

it("ignores saved expansions for sources that are no longer available", async () => {
  const scope = { project: "restored" };
  sessionStorage.setItem(`orb.files:${fileScopeKey(scope)}`, JSON.stringify({
    tabs: [{ source: "workspace", path: "note.md", name: "note.md", kind: "file" }],
    active: "workspace:note.md", expanded: ["workspace:", "controller:"], open: true,
  }));
  const { container, getByText } = render(() => <FilePanelProvider scope={scope}>Chat</FilePanelProvider>);
  await waitFor(() => expect(getByText("Readable note")).toBeTruthy());
  expect(container.querySelector(".file-preview")?.textContent).not.toContain("File source is unavailable");
});

it("keeps folder failures beside the folder and retries without discarding the preview", async () => {
  const mock = vi.mocked(api), original = mock.getMockImplementation()!;
  let fail = true;
  mock.mockImplementation(async (path, init) => {
    const q = JSON.parse(String(init?.body));
    if (q.action === "list" && fail) throw new Error("Folder read denied");
    return original(path, init);
  });
  try {
    const scope = { project: "folder-error" };
    sessionStorage.setItem(`orb.files:${fileScopeKey(scope)}`, JSON.stringify({
      tabs: [{ source: "workspace", path: "note.md", name: "note.md", kind: "file" }],
      active: "workspace:note.md", expanded: ["workspace:"], open: true,
    }));
    const { container, getByText, getByRole } = render(() => <FilePanelProvider scope={scope}>Chat</FilePanelProvider>);
    await waitFor(() => expect(getByText("Readable note")).toBeTruthy());
    await waitFor(() => expect(container.querySelector(".file-tree")?.textContent).toContain("Folder read denied"));
    expect(container.querySelector(".file-preview")?.textContent).not.toContain("Folder read denied");
    fail = false;
    fireEvent.click(getByRole("button", { name: "Retry folder" }));
    await waitFor(() => expect(container.querySelector(".file-tree")?.textContent).not.toContain("Folder read denied"));
    expect(getByText("Readable note")).toBeTruthy();
  } finally { mock.mockImplementation(original); }
});

it("still reports an unavailable source when the selected file needs it", async () => {
  const scope = { project: "missing-file-source" };
  sessionStorage.setItem(`orb.files:${fileScopeKey(scope)}`, JSON.stringify({
    tabs: [{ source: "removed", path: "note.md", name: "note.md", kind: "file" }],
    active: "removed:note.md", expanded: ["removed:"], open: true,
  }));
  const { container } = render(() => <FilePanelProvider scope={scope}>Chat</FilePanelProvider>);
  await waitFor(() => expect(container.querySelector(".file-preview")?.textContent).toContain("File source is unavailable"));
});

it("does not put a late folder error into a newly selected chat", async () => {
  const mock = vi.mocked(api), original = mock.getMockImplementation()!;
  let rejectOld!: (error: Error) => void;
  mock.mockImplementation(async (path, init) => {
    const q = JSON.parse(String(init?.body));
    if (q.action === "list" && q.project === "old")
      return new Promise((_resolve, reject) => { rejectOld = reject; });
    return original(path, init);
  });
  try {
    for (const project of ["old", "new"]) sessionStorage.setItem(`orb.files:${fileScopeKey({project})}`, JSON.stringify({
      tabs: [{ source: "workspace", path: "note.md", name: "note.md", kind: "file" }],
      active: "workspace:note.md", expanded: ["workspace:"], open: true,
    }));
    const [project, setProject] = createSignal("old");
    const { container, getByText } = render(() => <FilePanelProvider scope={{project:project()}}>Chat</FilePanelProvider>);
    await waitFor(() => expect(rejectOld).toBeTypeOf("function"));
    setProject("new");
    await waitFor(() => expect(getByText("Readable note")).toBeTruthy());
    rejectOld(new Error("Old folder failed"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(container.textContent).not.toContain("Old folder failed");
  } finally { mock.mockImplementation(original); }
});
