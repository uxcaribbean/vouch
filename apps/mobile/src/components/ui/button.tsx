import { ActivityIndicator, Pressable, StyleSheet, type PressableProps } from "react-native";

import { ThemedText } from "@/components/themed-text";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

type ButtonProps = PressableProps & {
  label: string;
  /** solid = primary action; soft = secondary; danger = destructive */
  variant?: "solid" | "soft" | "danger";
  loading?: boolean;
};

/**
 * Placeholder design system: monochrome, big. Minimum 56px touch target
 * per spec §6 (tradespeople on cheap Androids in bright sunlight).
 */
export function Button({
  label,
  variant = "solid",
  loading = false,
  disabled,
  style,
  ...rest
}: ButtonProps) {
  const theme = useTheme();
  const background =
    variant === "solid"
      ? theme.text
      : variant === "danger"
        ? "#B3261E"
        : theme.backgroundElement;
  const labelColor =
    variant === "solid" ? theme.background : variant === "danger" ? "#FFFFFF" : theme.text;

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      style={(state) => [
        styles.base,
        { backgroundColor: background, opacity: disabled || loading ? 0.5 : state.pressed ? 0.85 : 1 },
        typeof style === "function" ? style(state) : style,
      ]}
      {...rest}>
      {loading ? (
        <ActivityIndicator color={labelColor} />
      ) : (
        <ThemedText style={[styles.label, { color: labelColor }]}>{label}</ThemedText>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 56,
    borderRadius: Spacing.three,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Spacing.four,
    alignSelf: "stretch",
  },
  label: {
    fontWeight: "600",
    fontSize: 17,
  },
});
