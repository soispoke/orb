import { render } from "solid-js/web";
import { NativeMissionView } from "../src/App";
import { setConnection } from "../src/api";
import "../src/styles.css";

setConnection(location.origin, "test-token");
render(() => <NativeMissionView id="read-recovery" initial={{
  id: "read-recovery", title: "Message recovery", backend: "antigravity",
  status: new URLSearchParams(location.search).has("active") ? "active" : "completed", project: "default", history: [], created_at: "", updated_at: "",
}} />, document.getElementById("root")!);
