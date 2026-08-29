"use client";

import type { ReactNode } from "react";
import { BaseCaseList, type BaseCaseListProps } from "@/components/main-panels/common";
import type { VerificationCaseResultStatus } from "@/lib/verification/types";
import type { VerificationCaseRow } from "@/store/verification-cases";

export interface CaseVerdict {
  status: VerificationCaseResultStatus;
}

export type VerificationCaseListProps = BaseCaseListProps<VerificationCaseRow, CaseVerdict>;

export function VerificationCaseList(props: VerificationCaseListProps): ReactNode {
  return <BaseCaseList<VerificationCaseRow, CaseVerdict> {...props} />;
}
