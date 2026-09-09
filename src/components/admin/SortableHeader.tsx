import { useCallback, useState, type ReactNode } from "react";
import { TableHead } from "@/components/ui/table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function useTableSort<T extends string>(
  defaultColumn: T,
  defaultDirection: "asc" | "desc" = "asc",
) {
  const [sortColumn, setSortColumn] = useState<T>(defaultColumn);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">(defaultDirection);

  const handleSort = useCallback((column: T) => {
    setSortDirection((prev) => (sortColumn === column && prev === "asc" ? "desc" : "asc"));
    setSortColumn(column);
  }, [sortColumn]);

  return { sortColumn, sortDirection, handleSort };
}

interface SortableHeaderProps<T extends string> {
  label: string;
  column: T;
  currentColumn: T;
  currentDirection: "asc" | "desc";
  onSort: (column: T) => void;
  className?: string;
}

export function SortableHeader<T extends string>({
  label,
  column,
  currentColumn,
  currentDirection,
  onSort,
  className,
}: SortableHeaderProps<T>): ReactNode {
  const active = currentColumn === column;

  return (
    <TableHead
      className={cn(
        "cursor-pointer select-none transition-colors hover:bg-muted/40 group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      onClick={() => onSort(column)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSort(column);
        }
      }}
      tabIndex={0}
      role="columnheader"
      aria-sort={active ? (currentDirection === "asc" ? "ascending" : "descending") : "none"}
    >
      <div className="flex items-center gap-1.5">
        <span>{label}</span>
        {active ? (
          currentDirection === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5 shrink-0 text-foreground" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5 shrink-0 text-foreground" />
          )
        ) : (
          <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-30 group-hover:opacity-80" />
        )}
      </div>
    </TableHead>
  );
}
