import { StyleSheet, TextInput, View, type TextInputProps } from "react-native";

import { ThemedText } from "@/components/themed-text";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

type TextFieldProps = TextInputProps & {
  label?: string;
  error?: string | null;
  /** rendered inside the field, before the input (e.g. the +1 868 prefix) */
  prefix?: string;
};

export function TextField({ label, error, prefix, style, ...rest }: TextFieldProps) {
  const theme = useTheme();
  return (
    <View style={styles.wrap}>
      {label ? (
        <ThemedText type="smallBold" themeColor="textSecondary">
          {label}
        </ThemedText>
      ) : null}
      <View
        style={[
          styles.field,
          { backgroundColor: theme.backgroundElement },
          error ? styles.fieldError : null,
        ]}>
        {prefix ? (
          <ThemedText style={styles.prefix} themeColor="textSecondary">
            {prefix}
          </ThemedText>
        ) : null}
        <TextInput
          style={[styles.input, { color: theme.text }, style]}
          placeholderTextColor={theme.textSecondary}
          {...rest}
        />
      </View>
      {error ? (
        <ThemedText type="small" style={styles.errorText}>
          {error}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: Spacing.two,
    alignSelf: "stretch",
  },
  field: {
    minHeight: 56,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two,
  },
  fieldError: {
    borderWidth: 1,
    borderColor: "#B3261E",
  },
  prefix: {
    fontSize: 17,
  },
  input: {
    flex: 1,
    fontSize: 17,
    minHeight: 56,
  },
  errorText: {
    color: "#B3261E",
  },
});
