import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import type { ComponentProps } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { useThemeColor } from "../../../lib/useThemeColor";

type SymbolName = ComponentProps<typeof SymbolView>["name"];

export function SettingsStepperRow(props: {
  readonly disabled?: boolean;
  readonly icon: SymbolName;
  readonly label: string;
  readonly valueLabel: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly onChange: (value: number) => void;
}) {
  const icon = useThemeColor("--color-icon");
  const border = String(useThemeColor("--color-secondary-border"));
  const decrementDisabled = props.disabled === true || props.value <= props.min;
  const incrementDisabled = props.disabled === true || props.value >= props.max;
  const update = (value: number) => {
    Haptics.selectionAsync().catch(() => undefined);
    props.onChange(Math.min(props.max, Math.max(props.min, value)));
  };

  const button = (direction: "decrement" | "increment", disabled: boolean) => (
    <Pressable
      accessibilityLabel={`${direction === "increment" ? "Increase" : "Decrease"} ${props.label}`}
      accessibilityRole="button"
      disabled={disabled}
      className={
        disabled
          ? "size-10 items-center justify-center rounded-lg opacity-[0.35]"
          : "size-10 items-center justify-center rounded-lg active:bg-secondary"
      }
      onPress={() => update(props.value + (direction === "increment" ? props.step : -props.step))}
      style={{ borderColor: border, borderWidth: 1 }}
    >
      <SymbolView
        name={direction === "increment" ? "plus" : "minus"}
        size={17}
        tintColor={icon}
        type="monochrome"
        weight="semibold"
      />
    </Pressable>
  );

  return (
    <View
      className={
        props.disabled
          ? "flex-row items-center gap-4 p-4 opacity-[0.45]"
          : "flex-row items-center gap-4 p-4"
      }
    >
      <SymbolView name={props.icon} size={22} tintColor={icon} type="monochrome" weight="regular" />
      <View className="min-w-0 flex-1">
        <Text className="text-lg text-foreground">{props.label}</Text>
        <Text className="text-sm text-foreground-muted">{props.valueLabel}</Text>
      </View>
      <View className="flex-row gap-2">
        {button("decrement", decrementDisabled)}
        {button("increment", incrementDisabled)}
      </View>
    </View>
  );
}
