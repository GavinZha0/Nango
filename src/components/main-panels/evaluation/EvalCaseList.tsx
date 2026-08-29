"use client";

import type { ReactNode } from "react";
import { BaseCaseList, type BaseCaseListProps } from "@/components/main-panels/common";
import type { EvalCaseRow } from "@/store/evaluation-cases";

export interface CaseVerdict {
  status: "running" | "passed" | "failed" | "errored";
}

export type EvalCaseListProps = BaseCaseListProps<EvalCaseRow, CaseVerdict>;

export function EvalCaseList(props: EvalCaseListProps): ReactNode {
  return <BaseCaseList<EvalCaseRow, CaseVerdict> {...props} />;
}
