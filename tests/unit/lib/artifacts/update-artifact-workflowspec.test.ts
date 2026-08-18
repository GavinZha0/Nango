/**
 * Tests for updateArtifact + workflowSpec path (high priority).
 * 
 * Tests the core backend logic for updating workflow specs:
 * - validate → write WorkflowTable
 * - Error handling for invalid specs
 * - Integration with validate.ts
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

import { updateArtifact } from "@/lib/artifacts/update-artifact";
import { getNode, updateNode } from "@/lib/artifacts/service";
import { validate } from "@/lib/workflows/spec/validate";
import { db } from "@/lib/db";
import { WorkflowTable, type ArtifactEntity } from "@/lib/db/schema";
import type { CanonicalWorkflowSpec } from "@/lib/workflows";
import type { ArtifactBundle } from "@/lib/artifacts/bundle";

// Mock the dependencies properly
vi.mock("@/lib/db", () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));

vi.mock("@/lib/artifacts/service", () => ({
  getNode: vi.fn(),
  updateNode: vi.fn(),
}));

vi.mock("@/lib/workflows/spec/validate", () => ({
  validate: vi.fn(),
}));

vi.mock("@/lib/artifacts/bundle", () => ({
  buildArtifactBundle: vi.fn(),
}));

vi.mock("@/lib/artifacts/get-artifact", () => ({
  getArtifactBundle: vi.fn(),
}));

describe("updateArtifact — workflowSpec path", () => {
  const ownerId = "user-1";
  const artifactId = "art-1";
  const workflowId = "wf-1";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should throw BAD_REQUEST when artifact has no backing workflow", async () => {
    const mockArtifact = {
      id: artifactId,
      workflowId: null,
      name: "Test Artifact",
      createdBy: ownerId,
    };

    const validSpec: CanonicalWorkflowSpec = {
      name: "test-workflow",
      nodes: [],
      outputs: { result: "value" },
    };

    vi.mocked(getNode).mockResolvedValue(mockArtifact as unknown as ArtifactEntity);

    await expect(
      updateArtifact(artifactId, { workflowSpec: validSpec }, ownerId),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });
  });

  it("should throw BAD_REQUEST when spec validation fails", async () => {
    const mockArtifact = {
      id: artifactId,
      workflowId,
      name: "Test Artifact",
      createdBy: ownerId,
    };

    const invalidSpec: CanonicalWorkflowSpec = {
      name: "test-workflow",
      nodes: [],
      outputs: {}, // Invalid: empty outputs
    } as CanonicalWorkflowSpec;

    vi.mocked(getNode).mockResolvedValue(mockArtifact as unknown as ArtifactEntity);
    vi.mocked(validate).mockImplementation(() => {
      throw new Error("spec.outputs must contain at least one entry");
    });

    await expect(
      updateArtifact(artifactId, { workflowSpec: invalidSpec }, ownerId),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });
  });

  it("should call validate and db.update when valid workflowSpec is provided", async () => {
    const mockArtifact = {
      id: artifactId,
      workflowId,
      name: "Test Artifact",
      createdBy: ownerId,
    };

    const validSpec: CanonicalWorkflowSpec = {
      name: "test-workflow",
      nodes: [
        {
          type: "tool",
          schema_version: "1",
          id: 0,
          description: "test tool",
          depends_on: [],
          inputs: {
            source: "builtin",
            name: "test-tool",
            arguments: {},
          },
        },
      ],
      outputs: { result: "@nodes.0.result" },
    };

    vi.mocked(getNode).mockResolvedValue(mockArtifact as unknown as ArtifactEntity);
    vi.mocked(validate).mockReturnValue(undefined);
    const { getArtifactBundle } = await import("@/lib/artifacts/get-artifact");
    vi.mocked(getArtifactBundle).mockResolvedValue({ node: mockArtifact } as unknown as ArtifactBundle);

    await updateArtifact(artifactId, { workflowSpec: validSpec }, ownerId);

    expect(getNode).toHaveBeenCalledWith(artifactId, ownerId);
    expect(validate).toHaveBeenCalledWith(validSpec);
    expect(db.update).toHaveBeenCalledWith(WorkflowTable);
  });

  it("should call updateNode when metadata is updated without workflowSpec", async () => {
    const mockArtifact = {
      id: artifactId,
      workflowId,
      name: "Old Name",
      createdBy: ownerId,
    };

    vi.mocked(getNode).mockResolvedValue(mockArtifact as unknown as ArtifactEntity);
    vi.mocked(updateNode).mockResolvedValue({
      ...mockArtifact,
      name: "New Name",
    } as unknown as ArtifactEntity);
    const { getArtifactBundle } = await import("@/lib/artifacts/get-artifact");
    vi.mocked(getArtifactBundle).mockResolvedValue({
      node: { ...mockArtifact, name: "New Name" },
    } as unknown as ArtifactBundle);

    await updateArtifact(artifactId, { name: "New Name" }, ownerId);

    expect(updateNode).toHaveBeenCalledWith(artifactId, { name: "New Name" }, ownerId);
  });

  it("should handle empty patch (no updates)", async () => {
    const mockArtifact = {
      id: artifactId,
      workflowId,
      name: "Test Artifact",
      createdBy: ownerId,
    };

    vi.mocked(getNode).mockResolvedValue(mockArtifact as unknown as ArtifactEntity);
    const { getArtifactBundle } = await import("@/lib/artifacts/get-artifact");
    vi.mocked(getArtifactBundle).mockResolvedValue({ node: mockArtifact } as unknown as ArtifactBundle);

    await updateArtifact(artifactId, {}, ownerId);

    expect(updateNode).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});