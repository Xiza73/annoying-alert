/**
 * Display metadata for reminder categories.
 *
 * The backend owns the *set* of categories (Rust enum in
 * `src-tauri/src/models/category.rs`), but everything visual —
 * Spanish labels, icons, accent colors — lives here on the frontend.
 * The Rust side never renders anything.
 *
 * Ordering matters: the Select in `ReminderForm` iterates this array
 * as-is, and the most common categories come first.
 */

import {
  BookOpen,
  Briefcase,
  DollarSign,
  Dumbbell,
  Heart,
  House,
  type LucideIcon,
  Tag,
  User,
} from "lucide-react";

import type { Category } from "@/features/reminders/types";

export interface CategoryMeta {
  key: Category;
  label: string;
  /** Lucide icon component — rendered next to the label in the Select. */
  icon: LucideIcon;
  /** Hex accent used when the category is displayed as a badge. */
  accent: string;
}

/**
 * Ordered list of all categories with their display metadata. Keeping
 * this as an array (not a map) preserves the rendering order and
 * makes `.map()` trivial in the UI.
 */
export const CATEGORIES: readonly CategoryMeta[] = [
  { key: "general", label: "General", icon: Tag, accent: "#94a3b8" },
  { key: "health", label: "Salud", icon: Heart, accent: "#ef4444" },
  { key: "work", label: "Trabajo", icon: Briefcase, accent: "#3b82f6" },
  { key: "study", label: "Estudio", icon: BookOpen, accent: "#a855f7" },
  { key: "personal", label: "Personal", icon: User, accent: "#22c55e" },
  { key: "fitness", label: "Ejercicio", icon: Dumbbell, accent: "#f97316" },
  { key: "home", label: "Hogar", icon: House, accent: "#eab308" },
  { key: "finance", label: "Finanzas", icon: DollarSign, accent: "#10b981" },
] as const;

/**
 * Fast lookup by key. Built once at module load.
 */
const CATEGORY_BY_KEY: Record<Category, CategoryMeta> = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, c]),
) as Record<Category, CategoryMeta>;

/**
 * Resolve display metadata for a category key. Falls back to the
 * General entry for any unexpected value — this should never happen
 * given the enum on both sides, but the fallback keeps the UI safe if
 * the Rust enum gains a variant the frontend hasn't mirrored yet.
 */
export function getCategoryMeta(key: Category): CategoryMeta {
  return CATEGORY_BY_KEY[key] ?? CATEGORY_BY_KEY.general;
}

/**
 * Tuple of category keys, useful for building Zod enums:
 * `z.enum(CATEGORY_KEYS)`.
 */
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key) as unknown as readonly [
  Category,
  ...Category[],
];
