"""Тесты извлечения OTP из SMS govisit. Запуск: python3 -m unittest test_otp_extraction -v"""
import importlib.util
import os
import unittest

# otp-bridge.py содержит дефис в имени — импортируем через importlib.
_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("otp_bridge", os.path.join(_here, "otp-bridge.py"))
otp_bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(otp_bridge)

# Реальный формат SMS govisit (код заменён).
REAL_SMS = "קוד האימות לגוביזיט 0189.קוד זה תקף ל-5 דקות"


class ExtractCodeTests(unittest.TestCase):
    def test_real_sms_leading_zero(self):
        # Ведущий ноль обязан сохраниться: "0189", а не "189".
        self.assertEqual(otp_bridge.extract_code(REAL_SMS), "0189")

    def test_real_sms_without_leading_zero(self):
        sms = "קוד האימות לגוביזיט 7423.קוד זה תקף ל-5 דקות"
        self.assertEqual(otp_bridge.extract_code(sms), "7423")

    def test_validity_digit_not_extracted(self):
        # «5» из «ל-5 דקות» — не код.
        self.assertIsNone(otp_bridge.extract_code("קוד זה תקף ל-5 דקות"))

    def test_anchor_beats_fallback(self):
        # Постороннее 6-значное число не должно перебить код после якоря.
        sms = "מספר בקשה 123456. קוד האימות לגוביזיט 0189"
        self.assertEqual(otp_bridge.extract_code(sms), "0189")

    def test_long_digit_run_not_truncated(self):
        # Телефон после якоря (10 цифр) — не код: не отрезаем первые 8 цифр.
        # Fallback тоже отвергает: у 4–8-значного окна внутри длинного числа нет \b.
        self.assertIsNone(otp_bridge.extract_code("קוד האימות נשלח אל 0501234567"))

    def test_fallback_without_anchor(self):
        # Якоря нет (govisit переформулировал SMS) — работает общий fallback.
        self.assertEqual(otp_bridge.extract_code("Your code is 654321"), "654321")

    def test_no_code_returns_none(self):
        self.assertIsNone(otp_bridge.extract_code("שלום, מה שלומך?"))


class ExtractTextTests(unittest.TestCase):
    def test_attributed_body_roundtrip(self):
        # На новых macOS текст лежит в attributedBody (бинарный typedstream).
        # Лоссовый UTF-8-декод должен сохранить иврит и цифры.
        blob = b"\x04\x0bstreamtyped\x81\xe8\x03" + REAL_SMS.encode("utf-8") + b"\x86\x84\x01"
        text = otp_bridge._extract_text(None, blob)
        self.assertEqual(otp_bridge.extract_code(text), "0189")

    def test_text_column_preferred(self):
        # Если колонка text заполнена — attributedBody не трогаем.
        self.assertEqual(otp_bridge._extract_text("abc", b"xyz"), "abc")


if __name__ == "__main__":
    unittest.main()
