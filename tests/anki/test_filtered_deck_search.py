"""Validate the real Anki search semantics used to avoid redundant deck moves.

Unlike the exported-vault tests, this only needs anki + pytest (no GUI/Docker).
"""

from anki.collection import Collection


def test_preview_filtered_deck_home_search(tmp_path):
    _check_exact_deck_search(tmp_path, reschedule=False)


def test_rescheduling_filtered_deck_home_search(tmp_path):
    _check_exact_deck_search(tmp_path, reschedule=True)


def _check_exact_deck_search(tmp_path, reschedule):
    col = Collection(str(tmp_path / "collection.anki2"))
    try:
        home = col.decks.id("Home")
        child = col.decks.id("Home::Child")
        other = col.decks.id("Other")
        filtered = col.decks.new_filtered("Editing")
        cards = []
        for index, deck_id in enumerate([home, child, other]):
            note = col.new_note(col.models.by_name("Basic"))
            note["Front"] = f"Question {index}"
            note["Back"] = "Answer"
            col.add_note(note, deck_id)
            cards.append(note.cards()[0].id)

        # Home + its child enter the filtered deck; Other stays in a normal deck.
        deck = col.decks.get(filtered)
        deck["resched"] = reschedule
        deck["terms"] = [["deck:Home", 100, 0]]
        col.decks.save(deck)
        col.sched.rebuild_filtered_deck(filtered)
        assert col.get_card(cards[0]).odid == home
        assert col.get_card(cards[1]).odid == child

        # A named deck search would include child decks, but did: must not.
        card_ids = ",".join(map(str, cards))
        for deck_id, card_id in zip([home, child, other], cards):
            assert list(col.find_cards(f"did:{deck_id} cid:{card_ids}")) == [card_id]
        assert col.get_card(cards[0]).did == filtered
    finally:
        col.close()
