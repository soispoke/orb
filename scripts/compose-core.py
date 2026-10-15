#!/usr/bin/env python3
"""Deploy/check the personal Compose stack without orphaning its CLI proxy.

The proxy shares Core's network namespace. Recreating Core alone leaves an
apparently running proxy attached to the old container. A healthy Core HTTP
endpoint is therefore insufficient to validate a deployment. The default action
is read-only; restart explicitly recreates Core and its proxy together.
"""

import argparse
import json
import subprocess
import time


class ReadinessError(RuntimeError):
    pass


PROBE = r'''
import json, os, urllib.request

def get(url, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=4) as response:
        if response.status != 200:
            raise RuntimeError("unexpected HTTP status")
        return json.load(response)

get("http://127.0.0.1:80/api/health")
base = os.environ["CLI_PROXY_API_BASE_URL"].rstrip("/")
key = os.environ["CLI_PROXY_API_KEY"]
models = get(base + "/v1/models", {"Authorization": "Bearer " + key}).get("data", [])
if not isinstance(models, list) or not models:
    raise RuntimeError("proxy has not loaded any models")
print(json.dumps({"core": "ready", "proxy": "ready", "models": len(models)}))
'''


class Stack:
    def __init__(self, directory, files):
        self.directory = directory
        self.compose = ["compose"]
        for path in files:
            self.compose += ["-f", path]

    def docker(self, *args):
        try:
            result = subprocess.run(
                ["docker", *args], cwd=self.directory, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
                timeout=120 if args[0] == "compose" and "up" in args else 20,
            )
        except subprocess.TimeoutExpired as error:
            raise ReadinessError(f"Docker {args[0]} timed out") from error
        except OSError as error:
            raise ReadinessError("Could not run Docker in the Compose directory") from error
        if result.returncode:
            # Do not relay an application's response or environment into logs.
            raise ReadinessError(f"Docker {args[0]} failed (exit {result.returncode})")
        return result.stdout.strip()

    def container(self, service):
        ids = self.docker(*self.compose, "ps", "-q", service).splitlines()
        if len(ids) != 1:
            raise ReadinessError(f"Expected one running {service} container")
        raw = self.docker(
            "inspect", "--format",
            '{"id":{{json .Id}},"running":{{json .State.Running}},'
            '"network":{{json .HostConfig.NetworkMode}}}', ids[0],
        )
        try:
            data = json.loads(raw)
            if not isinstance(data, dict) or not isinstance(data.get("id"), str) or not data["id"]:
                raise ValueError("Invalid container identity")
            if not isinstance(data.get("network"), str):
                raise ValueError("Invalid container network")
        except ValueError as error:
            raise ReadinessError(f"Invalid Docker inspection for {service}") from error
        if data.get("running") is not True:
            raise ReadinessError(f"{service} is not running")
        return data["id"], data["network"]

    def check(self):
        core, _ = self.container("sandboxed-sh")
        _, network = self.container("cli-proxy")
        if network != f"container:{core}":
            raise ReadinessError("CLI proxy is attached to a different Core container; run repair-proxy")
        try:
            result = json.loads(self.docker("exec", core, "python3", "-c", PROBE))
        except ValueError as error:
            raise ReadinessError("Invalid readiness probe response") from error
        if (not isinstance(result, dict) or result.get("core") != "ready"
                or result.get("proxy") != "ready" or type(result.get("models")) is not int
                or result["models"] < 1):
            raise ReadinessError("Core/proxy readiness probe did not pass")
        return {key: result[key] for key in ("core", "proxy", "models")}

    def update(self, action):
        if action == "repair-proxy":
            self.container("sandboxed-sh")
            services = ["--no-deps", "cli-proxy"]
        elif action == "restart":
            services = ["sandboxed-sh", "cli-proxy"]
        else:
            raise ValueError("Unknown update action")
        self.docker(*self.compose, "up", "-d", "--no-build", "--pull", "never",
                    "--force-recreate", *services)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["check", "restart", "repair-proxy"], nargs="?", default="check")
    parser.add_argument("--directory", default=".")
    parser.add_argument("--file", action="append", dest="files")
    parser.add_argument("--attempts", type=int, default=20)
    args = parser.parse_args(argv)
    if args.attempts < 1:
        parser.error("--attempts must be positive")
    stack = Stack(args.directory, args.files or ["docker-compose.yml", "docker-compose.override.yml", "docker-compose.proxy.yml"])
    try:
        if args.action != "check":
            stack.update(args.action)
        for attempt in range(args.attempts):
            try:
                print(json.dumps(stack.check()))
                return 0
            except ReadinessError:
                if attempt + 1 == args.attempts:
                    raise
                time.sleep(1)
    except ReadinessError as error:
        parser.exit(1, f"Not ready: {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
