import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("compose_core", Path(__file__).with_name("compose-core.py"))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
READY = {"core": "ready", "proxy": "ready", "models": 54}


class ComposeCoreTests(unittest.TestCase):
    def setUp(self):
        self.stack = core.Stack("/fixture", ["base.yml", "proxy.yml"])

    def test_orphaned_proxy_fails_even_with_healthy_core(self):
        with patch.object(self.stack, "container", side_effect=[("current-core", "bridge"), ("proxy", "container:old-core")]), patch.object(self.stack, "docker") as docker:
            with self.assertRaisesRegex(core.ReadinessError, "different Core"):
                self.stack.check()
            docker.assert_not_called()

    def test_current_namespace_and_loaded_catalog_pass(self):
        with patch.object(self.stack, "container", side_effect=[("current-core", "bridge"), ("proxy", "container:current-core")]), patch.object(self.stack, "docker", return_value=json.dumps(READY)) as docker:
            self.assertEqual(self.stack.check(), READY)
            self.assertEqual(docker.call_args.args[:4], ("exec", "current-core", "python3", "-c"))

    def test_empty_or_invalid_catalog_cannot_report_ready(self):
        for response in [dict(READY, models=0), dict(READY, models=-1), dict(READY, models=True), dict(READY, models="54"), dict(READY, proxy="starting"), [], "invalid-json"]:
            with self.subTest(response=response), patch.object(self.stack, "container", side_effect=[("core", "bridge"), ("proxy", "container:core")]), patch.object(self.stack, "docker", return_value=json.dumps(response)):
                with self.assertRaises(core.ReadinessError):
                    self.stack.check()

    def test_invalid_json_cannot_report_ready(self):
        with patch.object(self.stack, "container", side_effect=[("core", "bridge"), ("proxy", "container:core")]), patch.object(self.stack, "docker", return_value="broken-json"):
            with self.assertRaises(core.ReadinessError):
                self.stack.check()

    def test_missing_or_ambiguous_service_fails_before_inspect(self):
        for ids in ["", "one\ntwo"]:
            with self.subTest(ids=ids), patch.object(self.stack, "docker", return_value=ids) as docker:
                with self.assertRaises(core.ReadinessError):
                    self.stack.container("cli-proxy")
                self.assertEqual(docker.call_count, 1)

    def test_stopped_container_cannot_report_ready(self):
        with patch.object(self.stack, "docker", side_effect=["core", json.dumps({"id": "core", "running": False, "network": "bridge"})]):
            with self.assertRaisesRegex(core.ReadinessError, "not running"):
                self.stack.container("sandboxed-sh")

    def test_inspection_requests_no_environment(self):
        with patch.object(self.stack, "docker", side_effect=["proxy", json.dumps({"id": "proxy", "running": True, "network": "container:core"})]) as docker:
            self.assertEqual(self.stack.container("cli-proxy"), ("proxy", "container:core"))
            self.assertEqual(docker.call_args.args[0:2], ("inspect", "--format"))
            self.assertNotIn("Env", docker.call_args.args[2])

    def test_restart_recreates_core_and_proxy_without_building_or_pulling(self):
        with patch.object(self.stack, "check_disk") as disk, patch.object(self.stack, "docker") as docker:
            self.stack.update("restart")
            disk.assert_called_once_with()
            docker.assert_called_once_with("compose", "-f", "base.yml", "-f", "proxy.yml", "up", "-d", "--no-build", "--pull", "never", "--force-recreate", "sandboxed-sh", "cli-proxy")

    def test_restart_refuses_low_disk_before_recreating_any_service(self):
        with patch.object(self.stack, "check_disk", side_effect=core.ReadinessError("low disk")), patch.object(self.stack, "docker") as docker:
            with self.assertRaisesRegex(core.ReadinessError, "low disk"):
                self.stack.update("restart")
            docker.assert_not_called()

    def test_disk_admission_uses_available_bytes_including_safety_reserve(self):
        for free, accepted in [(9, False), (29, False), (30, True), (40, True)]:
            with self.subTest(free=free), patch.object(self.stack, "container", return_value=("core", "bridge")), patch.object(self.stack, "docker", return_value=json.dumps({"available_bytes":free << 30,"required_bytes":30 << 30})):
                if accepted:
                    self.stack.check_disk()
                else:
                    with self.assertRaisesRegex(core.ReadinessError, "headroom insufficient"):
                        self.stack.check_disk()

    def test_malformed_disk_probe_fails_closed(self):
        for data in [{}, [], {"available_bytes":True,"required_bytes":1}, {"available_bytes":1,"required_bytes":0}]:
            with self.subTest(data=data), patch.object(self.stack, "container", return_value=("core", "bridge")), patch.object(self.stack, "docker", return_value=json.dumps(data)):
                with self.assertRaises(core.ReadinessError):
                    self.stack.check_disk()

    def test_repair_only_recreates_proxy_after_checking_core(self):
        events = []
        with patch.object(self.stack, "container", side_effect=lambda service: events.append(service)), patch.object(self.stack, "docker", side_effect=lambda *args: events.append(args)):
            self.stack.update("repair-proxy")
        self.assertEqual(events[0], "sandboxed-sh")
        self.assertEqual(events[1][-2:], ("--no-deps", "cli-proxy"))
        self.assertNotIn("sandboxed-sh", events[1])

    def test_repair_does_not_mutate_if_core_is_down(self):
        with patch.object(self.stack, "container", side_effect=core.ReadinessError("Core is down")), patch.object(self.stack, "docker") as docker:
            with self.assertRaises(core.ReadinessError):
                self.stack.update("repair-proxy")
            docker.assert_not_called()

    def test_default_action_is_read_only(self):
        with patch.object(core, "Stack") as stack, contextlib.redirect_stdout(io.StringIO()):
            stack.return_value.check.return_value = READY
            self.assertEqual(core.main([]), 0)
            stack.return_value.update.assert_not_called()

    def test_readiness_retries_do_not_repeat_restart(self):
        with patch.object(core, "Stack") as stack, patch.object(core.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
            stack.return_value.check.side_effect = [core.ReadinessError("loading"), READY]
            self.assertEqual(core.main(["restart", "--attempts", "2"]), 0)
            stack.return_value.update.assert_called_once_with("restart")
            self.assertEqual(stack.return_value.check.call_count, 2)

    def test_failed_readiness_exits_nonzero(self):
        with patch.object(core, "Stack") as stack, contextlib.redirect_stderr(io.StringIO()):
            stack.return_value.check.side_effect = core.ReadinessError("not ready")
            with self.assertRaises(SystemExit) as error:
                core.main(["--attempts", "1"])
            self.assertEqual(error.exception.code, 1)
            stack.return_value.update.assert_not_called()

    def test_subprocess_errors_do_not_leak_response_or_credentials(self):
        failure = subprocess.CompletedProcess([], 1, "fixture-secret", "fixture-secret")
        with patch.object(core.subprocess, "run", return_value=failure):
            with self.assertRaises(core.ReadinessError) as error:
                self.stack.docker("exec", "core", "probe")
            self.assertNotIn("fixture-secret", str(error.exception))

    def test_docker_timeout_is_bounded_and_safe(self):
        with patch.object(core.subprocess, "run", side_effect=subprocess.TimeoutExpired("docker", 20, stderr="fixture-secret")) as run:
            with self.assertRaisesRegex(core.ReadinessError, "timed out") as error:
                self.stack.docker("exec", "core", "probe")
            self.assertEqual(run.call_args.kwargs["timeout"], 20)
            self.assertNotIn("fixture-secret", str(error.exception))


class ProbeTests(unittest.TestCase):
    def probe(self, models):
        def response(data):
            value = io.BytesIO(json.dumps(data).encode())
            value.status = 200
            return value
        output = io.StringIO()
        with patch.dict(os.environ, {"CLI_PROXY_API_BASE_URL": "http://127.0.0.1:8317/", "CLI_PROXY_API_KEY": "fixture-secret"}), patch("urllib.request.urlopen", side_effect=[response({"status": "ok"}), response({"data": models})]) as request, contextlib.redirect_stdout(output):
            exec(core.PROBE, {})
        return output.getvalue(), request.call_args_list

    def test_probe_authenticates_inside_core_without_printing_key(self):
        output, calls = self.probe([{"id": "claude-opus-5-5"}])
        self.assertEqual(json.loads(output), dict(READY, models=1))
        self.assertEqual(calls[0].args[0].full_url, "http://127.0.0.1:80/api/health")
        self.assertEqual(calls[1].args[0].full_url, "http://127.0.0.1:8317/v1/models")
        self.assertEqual(calls[1].args[0].get_header("Authorization"), "Bearer fixture-secret")
        self.assertNotIn("fixture-secret", output)
        self.assertEqual(calls[1].kwargs["timeout"], 4)

    def test_proxy_starting_with_empty_catalog_fails(self):
        for models in [[], None, {}, "not-a-list"]:
            with self.subTest(models=models), self.assertRaisesRegex(RuntimeError, "not loaded"):
                self.probe(models)


if __name__ == "__main__":
    unittest.main()
