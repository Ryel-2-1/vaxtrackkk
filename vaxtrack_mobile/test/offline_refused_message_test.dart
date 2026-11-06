import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/utils/delivery_geofence_messages.dart';

void main() {
  const advice = 'Complete it here while at the clinic, or report a failed delivery.';
  const lead = 'Your offline record was not accepted by the dispatcher';

  test('a note without a stop gets one, so it does not run into the advice', () {
    expect(offlineRefusedMessage('Test'), '$lead: Test. $advice');
  });

  test('a note that already ends a sentence is left as written', () {
    expect(offlineRefusedMessage('Wrong clinic!'), '$lead: Wrong clinic! $advice');
    expect(offlineRefusedMessage(' Wrong clinic. '), '$lead: Wrong clinic. $advice');
  });

  test('no note, or a blank one, reads as a plain sentence', () {
    expect(offlineRefusedMessage(null), '$lead. $advice');
    expect(offlineRefusedMessage('   '), '$lead. $advice');
  });
}
