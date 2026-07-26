import { Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type ToggleChipProps = {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** 'radio' for single-select groups (region pickers); 'checkbox' for multi-select. */
  role?: 'radio' | 'checkbox';
  /** Override when the visible label is only meaningful next to a sibling row label (e.g. "On"/"Off"). */
  accessibilityLabel?: string;
};

/**
 * Monochrome selectable chip — same look as become-a-trader's region/trade
 * chips (spec M2), reused here for the M3 region pickers so directory
 * screens match the wizard exactly.
 */
export function ToggleChip({
  label,
  selected,
  onPress,
  role = 'radio',
  accessibilityLabel,
}: ToggleChipProps) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected, checked: selected }}
      style={[styles.chip, { backgroundColor: selected ? theme.text : theme.backgroundElement }]}>
      <ThemedText type="small" style={{ color: selected ? theme.background : theme.text }}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: 44,
    borderRadius: 22,
    paddingHorizontal: Spacing.three,
    justifyContent: 'center',
  },
});
