import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/services/push_service.dart';

void main() {
  test('a phone token is added once, moved to the end, and the list keeps the newest five', () {
    expect(mergePushTokens([], 'a'), ['a']);
    expect(mergePushTokens(['a', 'b'], 'a'), ['b', 'a'], reason: 'the same phone is not listed twice');
    expect(mergePushTokens(['1', '2', '3', '4', '5'], '6'), ['2', '3', '4', '5', '6']);
    expect(mergePushTokens(['', 'b'], 'c'), ['b', 'c'], reason: 'empty entries are dropped');
  });

  test('signing out removes only this phone', () {
    expect(withoutPushToken(['a', 'b', 'c'], 'b'), ['a', 'c']);
    expect(withoutPushToken(['a'], 'z'), ['a']);
  });

  test('the server and the app agree on the limit', () {
    expect(kMaxPushTokens, 5); // functions/src/riderPush.js MAX_TOKENS, firestore.rules size() <= 5
    expect(kPushTokensCollection, 'riderPushTokens');
  });
}
