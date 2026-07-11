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
};

/**
 * Monochrome selectable chip — same look as become-a-trader's region/trade
 * chips (spec M2), reused here for the M3 region pickers so directory
 * screens match the wizard exactly.
 */
export function ToggleChip({ label, selected, onPress, role = 'radio' }: ToggleChipProps) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={role}
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
