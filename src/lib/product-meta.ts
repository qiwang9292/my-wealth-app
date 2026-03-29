import { inferProductType } from "@/lib/infer-product-type";

export type ProductMetaInput = {
  category: string;
  subCategory: string | null;
  code: string | null;
  maturityDate: Date | null;
};

/** 保存前统一：推断 type；非「理财·定期」清空到期日 */
export function normalizeProductMeta(input: ProductMetaInput): {
  type: string;
  maturityDate: Date | null;
} {
  const isFinanceTerm = input.category === "理财" && (input.subCategory ?? "").trim() === "定期";
  return {
    type: inferProductType(input.category, input.subCategory, input.code),
    maturityDate: isFinanceTerm ? input.maturityDate : null,
  };
}
