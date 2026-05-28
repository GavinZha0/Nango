# Sandbox-runner image — minimal Python data-analysis runtime.
#
# Used by the LocalDockerAdapter via Docker or Podman (controlled by
# the SANDBOX_RUNTIME env var). One Dockerfile, both runtimes.
#
# Debian-slim base is required: DuckDB does NOT ship musl wheels, so
# Alpine images break `pip install duckdb`. Final image ~270 MB
# unpacked (vs ~135 MB if Alpine had worked) — still well below
# OpenSandbox's 2-4 GB.
#
# Python deps source: `requirements.txt` is generated from builtin
# skills' frontmatter `dependencies-python` declarations by
# `pnpm sandbox:build` (which runs `scripts/collect-skill-deps.ts`).
# DO NOT add inline `pip install pkg` lines here — declare the
# package in the relevant `skills/<name>/SKILL.md` instead so the
# requirements stay reproducible across local dev and CI.
#
# Multi-language extensions go through the SANDBOX_IMAGE env var
# override or a downstream image FROM sandbox-runner:latest.
#
# @see docs/sandbox.md §3.3
# @see docs/skills.md §9.x

FROM python:3.12-slim

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

# Drop privileges. UID 1000 to align with typical host-uid mappings;
# bind mounts come in as readonly so file ownership inside the
# container is irrelevant.
RUN useradd -m -u 1000 sandbox
USER sandbox

# Default cwd matches the D38 in-sandbox path contract
# (`./data/<name>/` relative to /work). LocalDockerAdapter ALSO
# passes `--workdir /work` explicitly on every `docker run` — that
# is the authoritative source. This line exists so a manual
# `docker run nango-sandbox ...` (without --workdir) still lands in
# the documented cwd instead of `/`.
WORKDIR /work
