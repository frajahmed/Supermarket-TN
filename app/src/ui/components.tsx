import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Text, TextInput, View, type TextInputProps } from 'react-native';
import { useTranslation } from 'react-i18next';
import { router } from 'expo-router';
import { ui } from './styles';

export function LoadingScreen({ error }: { error?: string }) {
  return (
    <SafeAreaView style={ui.safe}>
      <View style={ui.center}>{error ? <Text style={ui.error}>{error}</Text> : <ActivityIndicator />}</View>
    </SafeAreaView>
  );
}

export function CenteredMessage({ text }: { text: string }) {
  return <SafeAreaView style={ui.safe}><View style={ui.center}><Text>{text}</Text></View></SafeAreaView>;
}

export function ScreenScroll({ children }: { children: ReactNode }) {
  return (
    <SafeAreaView style={ui.safe}>
      <ScrollView contentContainerStyle={ui.container} keyboardShouldPersistTaps="handled">{children}</ScrollView>
    </SafeAreaView>
  );
}

export function BackLink() {
  const { t } = useTranslation();
  return <Pressable onPress={() => router.back()}><Text style={ui.link}>{t('back')}</Text></Pressable>;
}

export function Messages({ info, error }: { info?: string; error?: string }) {
  return (
    <>
      {info ? <Text style={{ color: '#176b87', fontWeight: '700' }}>{info}</Text> : null}
      {error ? <Text style={ui.error} accessibilityRole="alert">{error}</Text> : null}
    </>
  );
}

export function Field({ label, value, onChange, error, editable = true, ...input }: {
  label: string; value: string; onChange: (v: string) => void; error?: string | null; editable?: boolean;
} & Omit<TextInputProps, 'value' | 'onChangeText' | 'editable'>) {
  return (
    <View style={{ gap: 4 }}>
      <Text>{label}</Text>
      <TextInput value={value} onChangeText={onChange} editable={editable} style={[ui.input, !editable && ui.disabled]} {...input} />
      {error ? <Text style={ui.error}>{error}</Text> : null}
    </View>
  );
}

export function Chip({ label, active, onPress, disabled }: { label: string; active: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable style={[ui.chip, active && ui.chipActive]} onPress={onPress} disabled={disabled} accessibilityState={{ selected: active }}>
      <Text style={active ? ui.chipActiveText : undefined}>{label}</Text>
    </Pressable>
  );
}

export function ChipGroup<T extends string | number>({ values, selected, onSelect, label, disabled }: {
  values: readonly T[]; selected: T | null; onSelect: (v: T) => void; label: (v: T) => string; disabled?: boolean;
}) {
  return (
    <View style={ui.row}>
      {values.map((v) => <Chip key={String(v)} label={label(v)} active={selected === v} onPress={() => onSelect(v)} disabled={disabled} />)}
    </View>
  );
}

export function PrimaryButton({ label, onPress, busy, disabled }: { label: string; onPress: () => void; busy?: boolean; disabled?: boolean }) {
  return (
    <Pressable style={[ui.primary, (disabled || busy) && ui.disabled]} disabled={disabled || busy} onPress={onPress} accessibilityRole="button">
      {busy ? <ActivityIndicator color="white" /> : <Text style={ui.primaryText}>{label}</Text>}
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable style={[ui.secondary, disabled && ui.disabled]} disabled={disabled} onPress={onPress} accessibilityRole="button">
      <Text style={ui.secondaryText}>{label}</Text>
    </Pressable>
  );
}

/** Mindestlänge wie im Server (Storno, Sperre). */
export function ReasonConfirm({ placeholder, confirmLabel, onConfirm, onCancel, minLength = 3 }: {
  placeholder: string; confirmLabel: string; onConfirm: (reason: string) => void; onCancel: () => void; minLength?: number;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  return (
    <View style={ui.row}>
      <TextInput value={reason} onChangeText={setReason} placeholder={placeholder} style={ui.input} maxLength={500} />
      <SecondaryButton label={confirmLabel} disabled={reason.trim().length < minLength} onPress={() => onConfirm(reason.trim())} />
      <Pressable onPress={onCancel}><Text style={ui.link}>{t('back')}</Text></Pressable>
    </View>
  );
}
